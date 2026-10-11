const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const { execFile } = require('child_process');
const path = require('path');

// Exit codes of the obsidian-img-opt binary.
const EXIT_PARTIAL = 2;
const EXIT_INTERRUPTED = 130;

// Version of the JSON summary printed with --output json.
const SUMMARY_SCHEMA = 1;

const DEFAULT_SETTINGS = {
    binaryPath: 'obsidian-img-opt',
    quality: 40,
    gifMode: 'auto',
    gifLossy: 80,
    gifColors: 128,
    attachedDir: 'attachments',
    backupDir: '.originals_backup',
    keepBackup: true,
    optimizeLocal: false,
    linkFormat: 'markdown',
    timeout: 30,
    allowPrivateHosts: false
};

module.exports = class ImageOptimizerPlugin extends Plugin {
    async onload() {
        this.running = false;
        await this.loadSettings();

        this.addRibbonIcon('image-down', 'Optimize images in current note', () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile || activeFile.extension !== 'md') {
                new Notice('Please open a markdown note first.');
                return;
            }
            this.optimizeFile(activeFile);
        });

        this.addCommand({
            id: 'optimize-current-file',
            name: 'Optimize images in current note',
            checkCallback: (checking) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.extension === 'md') {
                    if (!checking) {
                        this.optimizeFile(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'optimize-entire-vault',
            name: 'Optimize images in entire vault',
            callback: () => this.optimizeVault()
        });

        this.addSettingTab(new ImageOptimizerSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getVaultBasePath() {
        const adapter = this.app.vault.adapter;
        return adapter && adapter.basePath ? adapter.basePath : '';
    }

    optimizeFile(file) {
        const vaultPath = this.getVaultBasePath();
        if (!vaultPath) {
            new Notice('Unable to resolve vault directory path.');
            return;
        }
        // The vault is passed too: it bounds which files may be touched and
        // lets the optimizer update other notes that embed the same image.
        const scopeArgs = ['--vault', vaultPath, '--file', path.join(vaultPath, file.path)];
        this.runBinary(scopeArgs, `Note "${file.basename}"`, `⏳ Optimizing images in "${file.basename}"...`);
    }

    optimizeVault() {
        const vaultPath = this.getVaultBasePath();
        if (!vaultPath) {
            new Notice('Unable to resolve vault directory path.');
            return;
        }
        this.runBinary(['--vault', vaultPath], 'Vault', '⏳ Scanning and optimizing images in the entire vault...');
    }

    buildArgs(scopeArgs) {
        const s = this.settings;
        return [
            ...scopeArgs,
            '--output', 'json',
            '--quality', String(s.quality),
            '--gif-mode', s.gifMode,
            '--gif-lossy', String(s.gifLossy),
            '--gif-colors', String(s.gifColors),
            '--attached-dir', s.attachedDir,
            '--backup-dir', s.backupDir,
            '--link-format', s.linkFormat,
            '--timeout', String(s.timeout),
            // Boolean flags are always passed explicitly: a bare flag can only
            // switch an option on, never off.
            `--keep-backup=${Boolean(s.keepBackup)}`,
            `--optimize-local=${Boolean(s.optimizeLocal)}`,
            `--allow-private-hosts=${Boolean(s.allowPrivateHosts)}`
        ];
    }

    runBinary(scopeArgs, scopeName, startMessage) {
        if (this.running) {
            new Notice('Image optimization is already running, please wait.');
            return;
        }
        this.running = true;
        new Notice(startMessage, 3000);

        const bin = this.settings.binaryPath.trim() || DEFAULT_SETTINGS.binaryPath;
        execFile(bin, this.buildArgs(scopeArgs), { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            this.running = false;
            if (stderr) {
                console.log('[ImageOptimizer]\n' + stderr);
            }

            const summary = parseSummary(stdout);
            const expectedExit = !error || error.code === EXIT_PARTIAL || error.code === EXIT_INTERRUPTED;
            if (!expectedExit) {
                console.error('[ImageOptimizer Error]', error, stderr);
                new Notice(`❌ Optimization failed: ${error.message}\nMake sure "${bin}" is in PATH or set its full path in settings.`, 8000);
                return;
            }
            if (!summary) {
                console.error('[ImageOptimizer] Unexpected output:\n' + stdout);
                new Notice(`❌ Unexpected output from "${bin}". Please update the binary to a version supporting --output json.`, 8000);
                return;
            }
            new Notice(describeSummary(scopeName, summary), summary.errors > 0 ? 8000 : 5000);
        });
    }
};

function parseSummary(stdout) {
    try {
        const summary = JSON.parse(stdout);
        return summary && summary.schema === SUMMARY_SCHEMA ? summary : null;
    } catch (e) {
        return null;
    }
}

function describeSummary(scopeName, s) {
    if (s.interrupted) {
        return `⏹️ ${scopeName}: optimization interrupted.`;
    }
    let message;
    if (s.imagesFound === 0) {
        message = `ℹ️ ${scopeName}: no images required optimization.`;
    } else if (s.savedBytes > 0) {
        message = `✅ ${scopeName} optimized! Saved: ${s.savedHuman} (-${s.savedPercent.toFixed(1)}%)`;
    } else {
        message = `✅ ${scopeName}: images processed, originals were already optimal.`;
    }
    if (s.errors > 0) {
        message += `\n⚠️ ${s.errors} problem(s), see the developer console.`;
        (s.warnings || []).forEach((w) => console.warn('[ImageOptimizer]', w));
    }
    return message;
}

class ImageOptimizerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        const settings = this.plugin.settings;
        const save = async (key, value) => {
            settings[key] = value;
            await this.plugin.saveSettings();
        };
        const integerSetting = (name, desc, key, min, max) => new Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addText(text => text
                .setValue(String(settings[key]))
                .onChange(async (val) => {
                    const n = Number(val);
                    if (Number.isInteger(n) && n >= min && n <= max) {
                        await save(key, n);
                    }
                }));
        const folderSetting = (name, desc, key) => new Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS[key])
                .setValue(settings[key])
                .onChange(async (val) => {
                    await save(key, val.trim() || DEFAULT_SETTINGS[key]);
                }));

        new Setting(containerEl).setName('Binary').setHeading();

        new Setting(containerEl)
            .setName('Binary path')
            .setDesc('Absolute path or command name of the obsidian-img-opt executable.')
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.binaryPath)
                .setValue(settings.binaryPath)
                .onChange(async (val) => save('binaryPath', val)));

        new Setting(containerEl).setName('Compression').setHeading();

        new Setting(containerEl)
            .setName('WebP quality')
            .setDesc('Lossy compression quality (1-100). Default is 40.')
            .addSlider(slider => slider
                .setLimits(1, 100, 1)
                .setValue(settings.quality)
                .setDynamicTooltip()
                .onChange(async (val) => save('quality', val)));

        new Setting(containerEl)
            .setName('GIF processing mode')
            .setDesc('"Auto" converts to animated WebP and falls back to GIF optimization. "WebP" never keeps the GIF format. "Optimize" keeps GIFs as GIF. "Keep" leaves every GIF untouched.')
            .addDropdown(drop => drop
                .addOption('auto', 'Auto (animated WebP with fallback)')
                .addOption('webp', 'WebP only')
                .addOption('optimize', 'Optimize GIF')
                .addOption('keep', 'Keep original GIF')
                .setValue(settings.gifMode)
                .onChange(async (val) => save('gifMode', val)));

        integerSetting('GIF lossy level', 'gifsicle --lossy level (0-200). Default is 80.', 'gifLossy', 0, 200);
        integerSetting('GIF colors', 'Maximum palette size when a GIF is kept as GIF (2-256). Default is 128.', 'gifColors', 2, 256);

        new Setting(containerEl).setName('Files').setHeading();

        folderSetting('Attachments folder', 'Folder created next to each note for downloaded images.', 'attachedDir');
        folderSetting('Backup folder', 'Folder (inside the image folder) where replaced originals are moved.', 'backupDir');

        new Setting(containerEl)
            .setName('Keep original backups')
            .setDesc('Move replaced originals into the backup folder instead of deleting them.')
            .addToggle(toggle => toggle
                .setValue(settings.keepBackup)
                .onChange(async (val) => save('keepBackup', val)));

        new Setting(containerEl)
            .setName('Optimize existing local images')
            .setDesc('Also convert local JPG/PNG/GIF/BMP/TIFF images. Every note embedding them is updated; an original is replaced only when nothing in the vault mentions it any more.')
            .addToggle(toggle => toggle
                .setValue(settings.optimizeLocal)
                .onChange(async (val) => save('optimizeLocal', val)));

        new Setting(containerEl)
            .setName('Link format')
            .setDesc('Syntax for rewritten remote images.')
            .addDropdown(drop => drop
                .addOption('markdown', 'Markdown: ![alt](attachments/...)')
                .addOption('wikilink', 'Wikilink: ![[attachments/...]]')
                .setValue(settings.linkFormat)
                .onChange(async (val) => save('linkFormat', val)));

        new Setting(containerEl).setName('Network').setHeading();

        integerSetting('Download timeout', 'Timeout for a single image download, in seconds.', 'timeout', 1, 3600);

        new Setting(containerEl)
            .setName('Allow private hosts')
            .setDesc('Allow downloads from localhost and private networks (intranet). Off by default to prevent notes from probing your local network.')
            .addToggle(toggle => toggle
                .setValue(settings.allowPrivateHosts)
                .onChange(async (val) => save('allowPrivateHosts', val)));
    }
}
