// Copies articles from the Archemist vault into src/content/articles/.
//
//   npm run sync                         every paste-ready note in Topics/ and Published/
//   npm run sync -- "Your Payload Is Too Big"   one topic
//   npm run sync -- "<topic>" --slug payload-encoding
//
// Source: "<topic> - paste-ready.md" (title, cover, body with [IMAGE n] markers) and the
// master note next to it (publish_date, pillar, LinkedIn URL). Nothing else leaves the vault.
// An article stays a draft until its master note holds the LinkedIn article URL.
// Vault path: ARCHEMIST_VAULT, or ../../Archemist from this repo.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = resolve(process.env.ARCHEMIST_VAULT ?? join(ROOT, '..', '..', 'Archemist'));
const OUT = join(ROOT, 'src', 'content', 'articles');
const FOLDERS = ['Topics', 'Published'];
const SUFFIX = ' - paste-ready.md';

const args = process.argv.slice(2);
const slugFlag = args.indexOf('--slug');
const slugArg = slugFlag >= 0 ? args.splice(slugFlag, 2)[1] : undefined;
const topicArg = args[0];

if (!existsSync(VAULT)) fail(`Vault not found at ${VAULT}. Set ARCHEMIST_VAULT.`);

const notes = FOLDERS.flatMap((folder) => {
	const dir = join(VAULT, folder);
	return existsSync(dir) ? readdirSync(dir).map((file) => ({ dir, file })) : [];
});
const pasteReady = notes.filter(({ file }) => file.endsWith(SUFFIX));
const targets = topicArg ? pasteReady.filter(({ file }) => file === topicArg + SUFFIX) : pasteReady;

if (targets.length === 0) fail(topicArg ? `No "${topicArg}${SUFFIX}" in ${FOLDERS.join(' or ')}.` : 'No paste-ready notes found.');
if (slugArg && targets.length > 1) fail('--slug needs a single topic.');

for (const target of targets) syncTopic(target);

function syncTopic({ dir, file }) {
	const topic = file.slice(0, -SUFFIX.length);
	const master = findMaster(topic);
	const meta = frontmatter(master.text);
	const source = readFileSync(join(dir, file), 'utf8');

	const title = header(source, 'Title');
	const coverPath = header(source, 'Cover');
	const coverAlt = header(source, 'Cover alt text');
	const body = source.slice(source.search(/^---\s*$/m)).replace(/^---\s*$/m, '');

	const linkedin = master.text.match(/https:\/\/www\.linkedin\.com\/pulse\/[^\s)>\]]+/)?.[0];
	const labs = body.match(/https:\/\/github\.com\/archemist-dev\/labs\/tree\/main\/[\w.-]+/)?.[0];
	const slug = slugArg ?? (labs ? basename(labs).replace(/^\d+-/, '') : kebab(topic));
	if (!meta.publish_date) fail(`${master.file}: no publish_date.`);

	const folder = join(OUT, slug);
	rmSync(folder, { recursive: true, force: true });
	mkdirSync(folder, { recursive: true });
	copyImage(coverPath, join(folder, 'cover.png'));

	const lines = body.split(/\r?\n/);
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const image = lines[i].match(/^\*\*\[IMAGE \d+: (.+?)\]\*\*\s*$/);
		if (image) {
			const altLine = lines[i + 1]?.match(/^Alt text:\s*(.+)$/);
			if (!altLine) fail(`${file}: no "Alt text:" line under ${lines[i]}`);
			const name = imageName(image[1]);
			copyImage(image[1], join(folder, name));
			out.push(`![${altLine[1].replace(/[[\]]/g, '')}](./${name})`);
			i++;
			continue;
		}
		// The sign-off points to the newsletter; the page has its own subscribe box.
		if (/^\*Archemist:.*\*\s*$/.test(lines[i])) continue;
		out.push(lines[i]);
	}
	const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

	const leftovers = markdown.match(/\[\[|\[IMAGE|!\[\[/g);
	if (leftovers) fail(`${file}: Obsidian syntax left in the body (${leftovers.join(', ')}).`);

	const description = markdown
		.split(/\n\s*\n/)
		.find((paragraph) => !/^[#!*-]/.test(paragraph.trim()))
		.replace(/\*\*|__|\*|`/g, '')
		.trim();

	const data = {
		title,
		description,
		pubDate: String(meta.publish_date),
		pillar: meta.pillar ?? 'architecture',
		cover: './cover.png',
		coverAlt,
		...(linkedin && { linkedin }),
		...(labs && { labs }),
		draft: !linkedin,
	};
	const yaml = Object.entries(data)
		.map(([key, value]) => `${key}: ${typeof value === 'boolean' ? value : JSON.stringify(value)}`)
		.join('\n');

	writeFileSync(join(folder, 'index.md'), `---\n${yaml}\n---\n\n${markdown}\n`);
	console.log(`${data.draft ? 'draft' : 'live '}  /articles/${slug}/  <- ${topic}`);
}

function findMaster(topic) {
	const match = notes.find(
		({ file }) => file.endsWith('.md') && !file.endsWith(SUFFIX) && (file === `${topic}.md` || file.startsWith(`${topic} - `)),
	);
	if (!match) fail(`No master note for "${topic}".`);
	return { ...match, text: readFileSync(join(match.dir, match.file), 'utf8') };
}

function frontmatter(text) {
	const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
	return Object.fromEntries(
		block
			.split(/\r?\n/)
			.map((line) => line.match(/^([\w-]+):\s*(.*?)\s*(#.*)?$/))
			.filter(Boolean)
			.map(([, key, value]) => [key, value]),
	);
}

function header(text, name) {
	const value = text.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm'))?.[1]?.trim();
	if (!value) fail(`Paste-ready note has no **${name}:** line.`);
	return value;
}

function copyImage(vaultPath, to) {
	const from = join(VAULT, vaultPath);
	if (!existsSync(from)) fail(`Image not found: ${vaultPath}`);
	copyFileSync(from, to);
}

// "Diagrams/Payload - 1 Size.png" -> "1-size.png"
function imageName(vaultPath) {
	const name = basename(vaultPath, '.png');
	return `${kebab(name.includes(' - ') ? name.slice(name.indexOf(' - ') + 3) : name)}.png`;
}

function kebab(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

function fail(message) {
	console.error(`sync: ${message}`);
	process.exit(1);
}
