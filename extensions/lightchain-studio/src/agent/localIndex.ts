/**
 * Local project search: finds the parts of the codebase a request is about, so
 * they can be attached to the prompt without the user pointing at files.
 *
 * Everything happens on this machine: files are split into chunks (Solidity by
 * contract member, other files by paragraph), and chunks are ranked against the
 * request with BM25 over identifier-aware words. No embeddings, no server, no
 * credits. Only the few chunks that are attached leave the IDE, inside the
 * encrypted prompt.
 */
export interface IndexFile { path: string; text: string }
export interface Chunk { path: string; start: number; end: number; text: string; /** e.g. "function withdraw" */ label?: string }
export interface Hit extends Chunk { score: number }

const MAX_CHUNK_LINES = 60;
const STOP = new Set(('a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our so that the their then there this to was we what when where which who why will with would you your ' +
	'add make create write change update fix use using please need want new file files code contract contracts function functions project test tests all any some get set should could also just like not').split(' '));

/** Words of a text: identifiers are kept whole and split (camelCase, snake_case), lower-cased. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? []) {
		const whole = word.toLowerCase();
		const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_]+/).map(p => p.toLowerCase()).filter(Boolean);
		for (const t of parts.length > 1 ? [whole, ...parts] : [whole]) {
			if (t.length > 1 && !STOP.has(t)) {
				out.push(stem(t));
			}
		}
	}
	return out;
}

/** Light stemming so "withdrawals" finds "withdraw" and "fees" finds "fee". */
function stem(t: string): string {
	if (t.length > 5 && t.endsWith('ing')) {
		return t.slice(0, -3);
	}
	if (t.length > 4 && t.endsWith('als')) {
		return t.slice(0, -3);
	}
	if (t.length > 4 && t.endsWith('ed')) {
		return t.slice(0, -2);
	}
	if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) {
		return t.slice(0, -1);
	}
	return t;
}

const SOL_MEMBER = /^\s*(?:(?:abstract\s+)?contract|interface|library|function|constructor|modifier|receive|fallback|struct|enum)\b\s*(\w*)/;

/** Splits a file into chunks that make sense on their own. */
export function chunkFile(path: string, text: string): Chunk[] {
	const lines = text.split('\n');
	const starts: { line: number; label?: string }[] = [{ line: 0 }];
	if (/\.sol$/i.test(path)) {
		lines.forEach((l, i) => {
			const m = SOL_MEMBER.exec(l);
			if (m && i > 0) {
				// keep the comment block (NatSpec) right above with its member
				let from = i;
				while (from > 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[from - 1])) {
					from--;
				}
				const kind = /\b(contract|interface|library|function|constructor|modifier|receive|fallback|struct|enum)\b/.exec(l)![1];
				starts.push({ line: from, label: `${kind}${m[1] ? ' ' + m[1] : ''}` });
			}
		});
	} else {
		// paragraphs / top-level declarations: break at blank lines once a chunk is big enough
		let last = 0;
		lines.forEach((l, i) => {
			const heading = /^#{1,6}\s/.test(l) || /^(export\s+)?(async\s+)?(function|class|interface|const|type)\b/.test(l) || /^\[[\w.-]+\]\s*$/.test(l);
			if (i > 0 && ((heading && i - last >= 4) || (!l.trim() && i - last >= 24))) {
				starts.push({ line: i });
				last = i;
			}
		});
	}
	const chunks: Chunk[] = [];
	const sorted = starts.filter((s, i) => i === 0 || s.line > starts[i - 1].line);
	sorted.forEach((s, i) => {
		const stop = i + 1 < sorted.length ? sorted[i + 1].line : lines.length;
		for (let from = s.line; from < stop; from += MAX_CHUNK_LINES) {
			const to = Math.min(stop, from + MAX_CHUNK_LINES);
			const body = lines.slice(from, to).join('\n');
			if (body.trim()) {
				chunks.push({ path, start: from + 1, end: to, text: body.replace(/\s+$/, ''), label: from === s.line ? s.label : undefined });
			}
		}
	});
	return chunks;
}

interface Doc { chunk: Chunk; tf: Map<string, number>; len: number; /** words of the member's name */ named: Set<string> }

export class LocalIndex {
	private docs: Doc[] = [];
	private df = new Map<string, number>();
	private avg = 1;
	private byFile = new Map<string, { text: string; docs: Doc[] }>();

	get files(): number {
		return this.byFile.size;
	}

	get chunks(): number {
		return this.docs.length;
	}

	/** Replaces the indexed files; unchanged files keep their chunks. */
	update(files: IndexFile[]): void {
		const next = new Map<string, { text: string; docs: Doc[] }>();
		for (const f of files) {
			const had = this.byFile.get(f.path);
			if (had && had.text === f.text) {
				next.set(f.path, had);
				continue;
			}
			const pathTokens = tokenize(f.path.replace(/\.[a-z.]+$/i, ''));
			next.set(f.path, {
				text: f.text,
				docs: chunkFile(f.path, f.text).map(chunk => {
					const tf = new Map<string, number>();
					// the file name and the member's name describe a chunk better than its body
					const tokens = [...tokenize(chunk.text), ...pathTokens, ...pathTokens, ...(chunk.label ? [...tokenize(chunk.label), ...tokenize(chunk.label)] : [])];
					for (const t of tokens) {
						tf.set(t, (tf.get(t) ?? 0) + 1);
					}
					return { chunk, tf, len: tokens.length, named: new Set(chunk.label ? tokenize(chunk.label) : []) };
				}),
			});
		}
		this.byFile = next;
		this.docs = [...next.values()].flatMap(f => f.docs);
		this.df = new Map();
		let total = 0;
		for (const d of this.docs) {
			total += d.len;
			for (const t of d.tf.keys()) {
				this.df.set(t, (this.df.get(t) ?? 0) + 1);
			}
		}
		this.avg = this.docs.length ? total / this.docs.length : 1;
	}

	/**
	 * The chunks a request is most likely about, best first. Returns nothing when
	 * the match is weak — better no context than misleading context.
	 */
	search(query: string, opts: { exclude?: Set<string>; maxChunks?: number; maxChars?: number; perFile?: number } = {}): Hit[] {
		const asked = [...new Set(tokenize(query))];
		const terms = asked.filter(t => this.df.has(t));
		if (!terms.length) {
			return [];
		}
		const n = this.docs.length;
		const k1 = 1.4, b = 0.75;
		const scored: { doc: Doc; score: number; matched: number }[] = [];
		for (const doc of this.docs) {
			if (opts.exclude?.has(doc.chunk.path)) {
				continue;
			}
			let score = 0;
			let matched = 0;
			let named = false;
			for (const t of terms) {
				const f = doc.tf.get(t);
				if (!f) {
					continue;
				}
				matched++;
				named ||= doc.named.has(t);
				const idf = Math.log(1 + (n - this.df.get(t)! + 0.5) / (this.df.get(t)! + 0.5));
				score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.len / this.avg));
			}
			// one shared word is noise, unless it is all the request has or it names this member
			if ((matched >= Math.min(2, asked.length) || named) && score > 0) {
				// a member whose name is asked for is what the request is about
				scored.push({ doc, score: score * (0.6 + 0.4 * matched / terms.length) * (named ? 1.6 : 1), matched });
			}
		}
		scored.sort((a, z) => z.score - a.score);
		const best = scored[0]?.score ?? 0;
		const hits: Hit[] = [];
		const perFile = new Map<string, number>();
		let chars = 0;
		for (const s of scored) {
			if (hits.length >= (opts.maxChunks ?? 4) || s.score < best * 0.35) {
				break;
			}
			const c = s.doc.chunk;
			const used = perFile.get(c.path) ?? 0;
			if (used >= (opts.perFile ?? 2) || chars + c.text.length > (opts.maxChars ?? 2_400)) {
				continue;
			}
			perFile.set(c.path, used + 1);
			chars += c.text.length;
			hits.push({ ...c, score: s.score });
		}
		return hits;
	}
}

/** The prompt block for local search hits (line-numbered like attached files). */
export function renderHits(hits: Hit[]): string {
	if (!hits.length) {
		return '';
	}
	const blocks = hits.map(h => `${h.path} lines ${h.start}–${h.end}${h.label ? ` (${h.label})` : ''}:\n\`\`\`\n${h.text.split('\n').map((l, i) => `${String(h.start + i).padStart(4)}  ${l}`).join('\n')}\n\`\`\``);
	return `Related code found in the project by local search (parts of files, line-numbered; read_file a file before changing it):\n\n${blocks.join('\n\n')}`;
}
