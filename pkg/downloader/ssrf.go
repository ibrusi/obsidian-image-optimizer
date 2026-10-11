package downloader

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"syscall"
)

// cgnat is the shared address space (RFC 6598), which is not public either.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// isPublicAddr reports whether ip is a globally routable unicast address.
func isPublicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() &&
		ip.IsGlobalUnicast() &&
		!ip.IsPrivate() &&
		!ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() &&
		!cgnat.Contains(ip)
}

// guardedDial refuses connections to non-public addresses. The check runs in
// Dialer.Control, i.e. on the address actually being connected to after DNS
// resolution, which also defeats DNS-rebinding tricks. Connections to the
// configured HTTP(S) proxy are allowed: the proxy itself may be local, and
// the target host is then resolved by the proxy.
func guardedDial(base *net.Dialer, allowed map[string]bool) func(ctx context.Context, network, addr string) (net.Conn, error) {
	guarded := *base
	guarded.Control = func(network, address string, _ syscall.RawConn) error {
		ap, err := netip.ParseAddrPort(address)
		if err != nil {
			return fmt.Errorf("%w: %s", ErrForbiddenHost, address)
		}
		if !isPublicAddr(ap.Addr()) {
			return fmt.Errorf("%w: %s", ErrForbiddenHost, ap.Addr())
		}
		return nil
	}

	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		if allowed[addr] {
			return base.DialContext(ctx, network, addr)
		}
		return guarded.DialContext(ctx, network, addr)
	}
}

// proxyAddrs returns the host:port of the proxies configured in the
// environment (HTTP_PROXY / HTTPS_PROXY), as the transport will dial them.
func proxyAddrs() map[string]bool {
	addrs := make(map[string]bool)
	for _, scheme := range []string{"http", "https"} {
		req := &http.Request{URL: &url.URL{Scheme: scheme, Host: "example.com"}}
		proxyURL, err := http.ProxyFromEnvironment(req)
		if err != nil || proxyURL == nil {
			continue
		}
		port := proxyURL.Port()
		if port == "" {
			port = map[string]string{"http": "80", "https": "443", "socks5": "1080"}[proxyURL.Scheme]
		}
		addrs[net.JoinHostPort(proxyURL.Hostname(), port)] = true
	}
	return addrs
}

// proxiedTargetCheck returns a check for requests that go through a proxy:
// the dial guard only sees the proxy address there, so the target host is
// resolved up front and rejected if any of its addresses is not public.
// (The proxy resolves the name again, so this is best effort against DNS
// rebinding; direct connections are fully covered by guardedDial.)
func proxiedTargetCheck(proxy func(*http.Request) (*url.URL, error), resolver *net.Resolver) func(context.Context, *url.URL) error {
	return func(ctx context.Context, u *url.URL) error {
		if proxy == nil {
			return nil
		}
		proxyURL, err := proxy(&http.Request{URL: u})
		if err != nil || proxyURL == nil {
			return nil // direct connection: guardedDial checks the real address
		}

		host := u.Hostname()
		if ip, err := netip.ParseAddr(host); err == nil {
			if !isPublicAddr(ip) {
				return fmt.Errorf("%w: %s", ErrForbiddenHost, ip)
			}
			return nil
		}
		ips, err := resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil // the proxy may resolve names we cannot; let it decide
		}
		for _, ip := range ips {
			if !isPublicAddr(ip) {
				return fmt.Errorf("%w: %s -> %s", ErrForbiddenHost, host, ip)
			}
		}
		return nil
	}
}
