import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLocalLinks, replaceLocalLinks } from '../src/domain/local-links.ts';

test('finds wikilinks and Markdown links to vault files', () => {
  const text = [
    '---',
    'cover: "[[covers/photo.png]]"',
    '---',
    '![[photo.png|200]] and [[photo.png#^block|see]]',
    '![my alt](img/my%20pic.png "title") [doc](notes/a.md#heading)',
    '[web](https://x.test/a.png) ![web](https://x.test/b.png) [mail](mailto:a@b.c) [top](#heading)',
    '```',
    '![[in-code.png]]',
    '```',
    '`[[inline.png]]` %% [[comment.png]] %%',
  ].join('\n');
  assert.deepEqual(findLocalLinks(text).map((l) => [l.embed, l.target, l.alias]), [
    [false, 'covers/photo.png', undefined],
    [true, 'photo.png', '200'],
    [false, 'photo.png', 'see'],
    [true, 'img/my pic.png', 'my alt'],
    [false, 'notes/a.md', 'doc'],
  ]);
});

test('replaceLocalLinks rewrites only the chosen links and counts them', () => {
  const text = 'A ![[p.png]] B [x](p.png) C ![[q.png]]';
  const { text: out, count } = replaceLocalLinks(text, (l) => (l.target === 'p.png' ? `<${l.embed ? 'embed' : 'link'}>` : undefined));
  assert.equal(out, 'A <embed> B <link> C ![[q.png]]');
  assert.equal(count, 2);
});

test('a literal percent sign in a file name survives decoding', () => {
  assert.deepEqual(findLocalLinks('![](100%.png)').map((l) => l.target), ['100%.png']);
});
