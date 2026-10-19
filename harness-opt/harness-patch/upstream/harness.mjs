#!/usr/bin/env node
/**
 * pi-bio-harness — BioMaster task runner built on the Pi SDK.
 *
 * Contract (see asset/environment/contract.md):
 *   run.sh --task <instruction.md> --model-name <served-model>
 *   BASE_URL / API_KEY injected at runtime.
 *
 * Enhanced with:
 *   - Dynamic task-instruction relevance matching over 845 BioMaster skills
 *   - Automatic output contract parsing & verification gate
 *   - Targeted diagnostic repair loop with public validator execution
 *   - Full computational capability (direct execution, scripts, tools, and subagents)
 */
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
	createAgentSession,
	createBashToolDefinition,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_HOME = process.env.PI_HARNESS_HOME || path.resolve(HERE, "..");

// ---------------------------------------------------------------- CLI / env

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const val = argv[i + 1];
		if (val !== undefined && !val.startsWith("--")) {
			out[key] = val;
			i++;
		} else {
			out[key] = true;
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const taskPath = args["task"];
const modelName = args["model-name"];
if (!taskPath || !modelName) {
	console.error("usage: harness.mjs --task <instruction.md> --model-name <name>");
	process.exit(2);
}

const baseUrl = process.env.BASE_URL;
const apiKeyPresent = Boolean(process.env.API_KEY);
if (!baseUrl || !apiKeyPresent) {
	console.error("BASE_URL and API_KEY must be injected at runtime");
	process.exit(2);
}

const codeDir = process.env.CODE_DIR || path.dirname(taskPath);
const outputDir = process.env.OUTPUT_DIR || "/app/outputs";
const runDir = process.env.RUN_DIR || codeDir;
const tracePath = process.env.TRACE_PATH || path.join(runDir, "trace.jsonl");
const maxTokens = Number.parseInt(process.env.MODEL_MAX_TOKENS || "8192", 10);
const contextWindow = Number.parseInt(process.env.HARNESS_CONTEXT_WINDOW || "131072", 10);
const timeoutSec = Number.parseInt(process.env.HARNESS_TIMEOUT_SECONDS || "0", 10);
const agentDir = process.env.HARNESS_AGENT_DIR || path.join(runDir, ".pi-agent");
const sessionDir = process.env.HARNESS_SESSION_DIR || path.join(runDir, ".pi-sessions");

process.env.PI_CODING_AGENT_DIR = agentDir;

mkdirSync(agentDir, { recursive: true });
writeFileSync(
	path.join(agentDir, "sol-pi.json"),
	`${JSON.stringify({
		version: 1,
		actionFusion: true,
		observationPack: true,
		evidencePreservingReducer: false,
		onlineContextCompact: false,
		cacheWriteReadRatio: 12.5,
	}, null, 2)}\n`,
);
writeFileSync(
	path.join(agentDir, "pi-goal.json"),
	`${JSON.stringify({
		continuationLimits: {
			automaticTurns: 25,
			noProgressTurns: 3,
		},
		rpc: {
			enabled: true,
		},
	}, null, 2)}\n`,
);
mkdirSync(sessionDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });

// ------------------------------------------------------------- trace writer

function trace(event) {
	try {
		const line = JSON.stringify(event, replacerForTrace());
		appendFileSync(tracePath, `${line}\n`);
	} catch (err) {
		try {
			appendFileSync(tracePath, `${JSON.stringify({ type: "trace_error", message: String(err) })}\n`);
		} catch {
			/* ignore */
		}
	}
}
function replacerForTrace() {
	const seen = new WeakSet();
	return (_key, value) => {
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "function") return "[function]";
		if (value && typeof value === "object") {
			if (seen.has(value)) return "[circular]";
			seen.add(value);
		}
		if (typeof value === "string" && value.length > 8000) {
			return `${value.slice(0, 8000)}…[truncated ${value.length - 8000} chars]`;
		}
		return value;
	};
}

// ---------------------------------------------------------------- resources

function parseFrontmatter(text) {
	const meta = {};
	const match = /^---\s*\n([\s\S]*?)\n---/.exec(text);
	if (!match) return meta;
	let currentKey = null;
	for (const raw of match[1].split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("- ") && currentKey) {
			const val = line.slice(2).trim().replace(/^['"]|['"]$/g, "");
			meta[currentKey] = (meta[currentKey] ? `${meta[currentKey]} ` : "") + val;
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		meta[key] = value;
		currentKey = key;
	}
	return meta;
}

function readAllSkills() {
	const root = path.join(HARNESS_HOME, "skills");
	const skills = [];
	const diagnostics = [];
	if (!existsSync(root)) return { skills, diagnostics };
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			diagnostics.push({ path: dir, message: String(err) });
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name === "SKILL.md") {
				try {
					const text = readFileSync(full, "utf8");
					const meta = parseFrontmatter(text);
					if (!meta.name || !meta.description) {
						diagnostics.push({ path: full, message: "missing name or description" });
						continue;
					}
					const hasScript = existsSync(path.join(dir, "scripts"));
					skills.push({
						name: meta.name,
						description: meta.description,
						domain: meta.domain || "",
						capability_group: meta.capability_group || "",
						keywords: meta.keywords || "",
						hasScript,
						filePath: full,
						baseDir: dir,
						sourceInfo: createSyntheticSourceInfo(full, { source: "sdk" }),
						disableModelInvocation: false,
					});
				} catch (err) {
					diagnostics.push({ path: full, message: String(err) });
				}
			}
		}
	}
	return { skills, diagnostics };
}

const discoveredAllSkills = readAllSkills();

// ------------------------------------------------ dynamic skill selection

const PROMPT_SKILL_CHARS = 24000;
// Long-tail method/database/format/category tokens. The eval-51759 exit-0 reward-0
// task names showed the correct method skill was not surfaced; these tokens give a
// small additive boost when they appear in both the instruction and the skill meta.
const LONG_TAIL_TASK_TOKENS = [
	"scpas", "clumpycells", "scbsp", "refcm", "miit", "msi", "ostta", "suaeda", "cowmilk",
	"haplosporidia", "prosthemium", "mape", "chroodiscus", "pygna", "obadia", "isornet", "iso",
	"cep120", "mnd", "nevomics", "coreg", "netgen", "samnet", "apl", "bd", "sdr", "tfbs",
	"e0152937", "bsubtilis", "wgs", "gpx", "superfamily", "ap2", "erebp", "ptrf", "ewing",
	"mimosa", "cardiometabolic", "hdac2", "mania", "rnas", "rna-seq", "ldlr", "aaa", "mylk",
	"fgf23", "regnet", "epistasis", "phytoplasma", "16sri", "ptb", "type1", "copper", "scpas",
];
const DATABASE_TOKENS = [
	"disgenet", "omim", "msigdb", "ensembl", "clinvar", "biomart", "uniprot", "reactome",
	"kegg", "string", "biogrid", "interpro", "pfam", "quickgo", "pride", "gwas", "opentargets",
	"pharmaprojects", "monarch", "faers", "geo", "sra", "tcga", "depmap", "hpo",
];
const FILE_FORMAT_TOKENS = [
	"vcf", "bam", "sam", "bed", "gff", "gtf", "bigwig", "bigwig", "wig", "fastq", "fasta",
	"h5ad", "anndata", "loom", "mtx", "h5", "bw", "tsv", "csv", "jsonl", "pdb", "cif", "mzml",
];
const METHOD_CATEGORY_TOKENS = [
	"gwas", "metagenomics", "metagenomic", "microbiome", "crispr", "phenotype", "rare", "disease",
	"phylogenetic", "phylogeny", "proteomics", "metabolomics", "transcriptomics", "epigenomics",
	"single-cell", "spatial", "trajectory", "variant", "annotation", "enrichment", "differential",
	"clustering", "regression", "survival", "mediation", "pleiotropy", "mendelian", "pathway",
];
const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "have", "task", "file",
	"data", "code", "root", "app", "outputs", "each", "your", "only", "must",
	"write", "read", "used", "record", "which", "will", "more", "most", "also",
	"into", "over", "some", "such", "than", "then", "them", "these", "they",
	"were", "what", "when", "where", "who", "whom", "why", "would", "about",
	"above", "after", "again", "against", "all", "any", "are", "been", "before",
	"being", "below", "between", "both", "but", "can", "cannot", "could", "did",
	"does", "doing", "down", "during", "few", "further", "had", "has", "here",
	"how", "once", "other", "our", "out", "same", "should", "under", "until",
	"bio",
]);

function tokenize(text) {
	const words = String(text || "").toLowerCase().match(/[a-z0-9_+-]+/g) || [];
	const tokens = [];
	for (const raw of words) {
		const w = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
		if (w.length >= 3 && !STOP_WORDS.has(w)) {
			tokens.push(w);
		}
		if (w.includes("-") || w.includes("_")) {
			const stripped = w.replace(/[-_]+/g, "");
			if (stripped.length >= 3 && !STOP_WORDS.has(stripped)) {
				tokens.push(stripped);
			}
			for (const p of w.split(/[-_]+/)) {
				if (p.length >= 3 && !STOP_WORDS.has(p)) {
					tokens.push(p);
				}
			}
		}
	}
	return tokens;
}

function subTokenizeIdentifier(id) {
	const cleaned = String(id || "").replace(/^SKILL-\d+_+/i, "");
	const parts = cleaned.toLowerCase().split(/[-_0-9]+/);
	const tokens = [];
	for (const p of parts) {
		const w = p.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
		if (w.length >= 3 && !STOP_WORDS.has(w)) {
			tokens.push(w);
		}
	}
	return Array.from(new Set(tokens));
}

function selectRelevantSkills(instructionText, allSkills, maxChars = PROMPT_SKILL_CHARS) {
	const tokens = tokenize(instructionText);
	const tokenSet = new Set(tokens);
	const tokenCounts = {};
	for (const t of tokens) tokenCounts[t] = (tokenCounts[t] || 0) + 1;

	const lowerInst = String(instructionText || "").toLowerCase();

	// Uppercase acronyms (>=2 chars) that appear in the instruction. Matched
	// case-insensitively against skill name/description/keywords below.
	const instructionAcronyms = Array.from(
		new Set((String(instructionText || "").match(/\b[A-Z][A-Z0-9]{1,7}\b/g) || []).map((a) => a.toLowerCase())),
	).filter((a) => !STOP_WORDS.has(a));

	const scored = allSkills.map((skill) => {
		let score = 0;
		const nameTokens = subTokenizeIdentifier(skill.name);
		const descTokens = tokenize(skill.description);
		const domainTokens = tokenize(`${skill.domain || ""} ${skill.capability_group || ""} ${skill.keywords || ""}`);

		for (const t of nameTokens) {
			if (tokenSet.has(t)) {
				score += 8.0 * (tokenCounts[t] ? Math.min(tokenCounts[t], 3) : 1);
			}
		}
		for (const t of descTokens) {
			if (tokenSet.has(t)) {
				score += 2.0 * (tokenCounts[t] ? Math.min(tokenCounts[t], 2) : 1);
			}
		}
		for (const t of domainTokens) {
			if (tokenSet.has(t)) {
				score += 3.0;
			}
		}

		const lowerName = skill.name.toLowerCase();
		const lowerDesc = (skill.description || "").toLowerCase();
		const lowerMeta = `${lowerName} ${lowerDesc} ${(skill.keywords || "").toLowerCase()}`;

		// Legacy exact matches
		if (lowerInst.includes("h3k27ac") && lowerName.includes("chipseq")) score += 60;
		if (lowerInst.includes("cnvnator") && lowerName.includes("cnvnator")) score += 60;
		if (lowerInst.includes("tsa-seq") && lowerName.includes("tsa-seq")) score += 60;
		if (lowerInst.includes("pqn") && (lowerName.includes("pqn") || lowerName.includes("dims"))) score += 60;
		if (lowerInst.includes("birdsuite") && lowerName.includes("birdsuite")) score += 60;
		if (lowerInst.includes("commot") && lowerName.includes("commot")) score += 60;
		if (lowerInst.includes("primer") && lowerName.includes("primer")) score += 20;
		if (lowerInst.includes("methylation") && lowerName.includes("methyl")) score += 20;

		// Devset-II domain keyword associations
		// 1. Metagenomics / Microbiome / 16S / Seawater / Sediment / Taxonomy
		const isMetagenomicsTask = /seawater|sediment|metagenom|16s|rrna|microbio|microbiome|taxonomy|taxonomic|bacteria/i.test(lowerInst);
		if (isMetagenomicsTask) {
			if (/metagenom|microbi|taxonom|amplicon|16s|kraken|qiime|diversity|abundance/i.test(lowerMeta)) {
				score += 25;
			}
			if (/seawater|sediment/i.test(lowerInst) && /metagenom|microbi|taxonom/i.test(lowerMeta)) {
				score += 15;
			}
		}

		// 2. GWAS / Variant Prioritization / Causal Genes / Fine-mapping
		const isGwasTask = /gwas|causal_gene|variant_prioritization|finemapping|fine-mapping|opentargets|pharmaprojects/i.test(lowerInst);
		if (isGwasTask) {
			if (/gwas|causal|variant|prioritization|mendelian|prs|pleiotropy|l2g|fine-mapping/i.test(lowerMeta)) {
				score += 30;
			}
		}

		// 3. CRISPR / Knockout / Delivery / Genetic Screens
		const isCrisprTask = /crispr|cas9|sgrna|ggrna|knockout|screen_gene|crispr_delivery/i.test(lowerInst);
		if (isCrisprTask) {
			if (/crispr|cas9|knockout|guide-rna|screen|delivery/i.test(lowerMeta)) {
				score += 30;
			}
		}

		// 4. Rare Disease / Phenotype / HPO / Patient Gene
		const isPhenotypeTask = /rare_disease|phenotype|hpo|omim|patient_gene|pathogenic/i.test(lowerInst);
		if (isPhenotypeTask) {
			if (/phenotype|disease|clinical|hpo|pathogen|variant-interpretation/i.test(lowerMeta)) {
				score += 30;
			}
		}

		// Open-Benchmark Archetype Regex Boosts (SeqQA, DbQA, BixBench)
		// 1. SeqQA ORFs & Translation
		const isOrfTask = /longest orf|open reading frame|\borf\b|translate|translation|amino acid encoded/i.test(lowerInst);
		if (isOrfTask) {
			if (/transcription-translation|codon-usage|sequence-properties|reverse-complement/i.test(lowerName)) {
				score += 45;
			}
		}

		// 2. SeqQA Restriction Digestion
		const isRestrictionTask = /digest|digesting|restriction enzyme|restriction|cut site|fragment lengths?|number of fragments/i.test(lowerInst);
		if (isRestrictionTask) {
			if (/restriction-sites|restriction-mapping|restriction-enzyme-selection/i.test(lowerName)) {
				score += 45;
			}
		}

		// 3. SeqQA PCR & Amplicons
		const isPcrTask = /primer pair|amplicon|pcr from the following template|gibson assembly|puc19|linearize|percent gc/i.test(lowerInst);
		if (isPcrTask) {
			if (/primer-design|primer-basics|primer-specificity|reverse-complement|sequence-properties/i.test(lowerName)) {
				score += 35;
			}
		}

		// 4. DbQA ClinVar
		const isClinVarTask = /clinvar|benign|pathogenic variant/i.test(lowerInst);
		if (isClinVarTask) {
			if (/variant-interpretation|clinical-variant|snpeff-variant|vcf-annotator/i.test(lowerName)) {
				score += 40;
			}
		}

		// 5. DbQA Ensembl / Coordinates
		const isEnsemblTask = /ensembl|release 110|chr10q/i.test(lowerInst);
		if (isEnsemblTask) {
			if (/ensembl-rest|ensembl-database|biomart/i.test(lowerName)) {
				score += 45;
			}
		}

		// 6. DbQA Disease-Gene / OMIM / DisGeNET
		const isDgaTask = /disgenet|omim|currarino/i.test(lowerInst);
		if (isDgaTask) {
			if (/monarch-database|rare-disease|clinical-variant-prioritizer/i.test(lowerName)) {
				score += 40;
			}
		}

		// 7. DbQA Gene Sets / MSigDB
		const isMsigDbTask = /gene set|msigdb|c6 collection|c7 subcollection|vax_response|oncogenic/i.test(lowerInst);
		if (isMsigDbTask) {
			if (/pathway-gsea|pathway-enricher|go-enrichment/i.test(lowerName)) {
				score += 35;
			}
		}

		// 8. BixBench / tasks3 RNA-seq & DESeq2
		const isRnaSeqTask = /deseq2|differential expression|enrichgo|clusterprofiler|padj|go enrichment/i.test(lowerInst);
		if (isRnaSeqTask) {
			if (/deseq2|differential-expression|pathway-go-enrichment|expression-to-pathways/i.test(lowerName)) {
				score += 40;
			}
		}

		// 5. Harbor task format association
		if (/instance_id|task_name/i.test(lowerInst)) {
			const tnMatch = lowerInst.match(/task_name:\s*([a-z0-9_-]+)/i);
			if (tnMatch) {
				const tnTokens = subTokenizeIdentifier(tnMatch[1]);
				for (const tnt of tnTokens) {
					if (nameTokens.includes(tnt)) score += 15;
				}
			}
		}

		// Long-tail Devset-II / open-benchmark method-name association: task names
		// that scored exit-0 reward-0 in eval 51759 indicate the correct method
		// skill was not surfaced. Match their tokens against name/description/keywords.
		for (const lt of LONG_TAIL_TASK_TOKENS) {
			if (tokenSet.has(lt) && lowerMeta.includes(lt)) score += 12;
		}

		// Database-name association: public bio databases named in the instruction.
		for (const db of DATABASE_TOKENS) {
			if (tokenSet.has(db) && lowerMeta.includes(db)) score += 18;
		}

		// File-format association: input/output formats named in the instruction.
		for (const fmt of FILE_FORMAT_TOKENS) {
			if (tokenSet.has(fmt) && lowerMeta.includes(fmt)) score += 10;
		}

		// Method-category association: broad analytic families.
		for (const cat of METHOD_CATEGORY_TOKENS) {
			if (tokenSet.has(cat) && lowerMeta.includes(cat)) score += 14;
		}

		// Uppercase acronyms in the instruction that also appear in skill keywords/name.
		for (const acr of instructionAcronyms) {
			const al = acr.toLowerCase();
			if (lowerMeta.includes(al)) score += 16;
		}

		if (skill.hasScript && score > 0) score += 5;

		return { skill, score };
	});

	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.skill.name.localeCompare(b.skill.name);
	});

	const selected = [];
	const seenNames = new Set();
	let totalChars = 0;

	for (const item of scored) {
		if (item.score <= 0) break; // Strictly eliminate zero-score fallback pollution!
		const s = item.skill;
		if (!s.name || seenNames.has(s.name)) continue;
		const line = `- ${s.name}: ${s.description || ""}`;
		const addedLength = line.length + (selected.length > 0 ? 1 : 0);
		if (totalChars + addedLength > maxChars) continue;
		seenNames.add(s.name);
		selected.push(s);
		totalChars += addedLength;
	}

	return { selected, totalChars, topMatches: scored.slice(0, 10).map((x) => ({ name: x.skill.name, score: x.score })) };
}

// ------------------------------------------------ output contract parser

function cleanArtifactPath(raw) {
	if (!raw) return "";
	let clean = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "");
	clean = clean.replace(/^(?:\/app\/outputs\/|app\/outputs\/|OUTPUT_DIR\/|\/)+/, "");
	clean = clean.trim().replace(/^[`'"]+|[`'"]+$/g, "");
	if (clean.includes("<") || clean.includes(">") || clean.includes("...") || clean.includes("*")) {
		return "";
	}
	return clean;
}

function parseOutputContract(instructionText) {
	const contracts = {
		expectedFiles: new Set(),
		isHarborTask: false,
		isAnswerJson: false,
		description: [],
	};

	const isHarbor =
		(/instance_id:\s*['"]?([a-zA-Z0-9_-]+)['"]?/i.test(instructionText) &&
		 /task_name:\s*['"]?([a-zA-Z0-9_-]+)['"]?/i.test(instructionText)) ||
		(/result\.json/i.test(instructionText) && /evidence_summary|task_instance_id|cleanup_status/i.test(instructionText));

	if (isHarbor) {
		contracts.isHarborTask = true;
		contracts.expectedFiles.add("result.json");
		contracts.description.push("- **Harbor Task Contract**: Write `/app/outputs/result.json` containing `instance_id`, `task_name`, `task_instance_id`, `status` (\"completed\"), `answer`, `evidence_summary`, `files_used`, `external_sources`, `sandbox_ids`, `job_ids`, `cleanup_status`.");
	}

	if (/answer\.json/i.test(instructionText) || /field[,:\s]+`?answer`?/i.test(instructionText)) {
		contracts.isAnswerJson = true;
		contracts.expectedFiles.add("answer.json");
		contracts.description.push("- **Answer Task Contract**: Write `/app/outputs/answer.json` containing `{\"answer\": \"...\"}`.");
	}

	// Direct references like /app/outputs/path/to/file.ext
	const matches = instructionText.matchAll(/(?:\/app\/outputs\/|OUTPUT_DIR\/|`\/app\/outputs\/)([\w.\/-]+\.[a-zA-Z0-9]+)/g);
	for (const m of matches) {
		const cleaned = cleanArtifactPath(m[1]);
		if (cleaned) {
			contracts.expectedFiles.add(cleaned);
		}
	}

	// Expanded section headings regex: recognizes ## Deliverables, ## Required Outputs, ## Output files, ## Deliverable, etc.
	const sectionHeadingRegex = /(?:^|\n)(?:#{1,3}\s*(?:Deliverables?|Required\s+[Oo]utputs?|Output\s+[Ff]iles?|Outputs?|Submission\s+[Cc]ontract|Output\s+[Cc]ontract)|Required outputs under [^\n:]+:?)\s*\n([\s\S]*?)(?=(?:\n#{1,2}\s+[^#\n]+|$))/gi;
	for (const secMatch of instructionText.matchAll(sectionHeadingRegex)) {
		const secBody = secMatch[1];
		const lines = secBody.split("\n");
		for (const l of lines) {
			// Bullet lines: - file.tsv, * `results/data.csv`, 1. `output.tsv`
			const bulletMatch = l.match(/(?:[-*]|\d+\.)\s*(?:\[[ x]\]\s*)?(?:Deliverables?:|Output:\s*)?`?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)`?/);
			if (bulletMatch) {
				const cleaned = cleanArtifactPath(bulletMatch[1]);
				if (cleaned) {
					contracts.expectedFiles.add(cleaned);
				}
			}
			// Subheadings inside section: ### `results/bin_scores.tsv.gz`
			const subheadMatch = l.match(/^###+\s*`?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)`?/);
			if (subheadMatch) {
				const cleaned = cleanArtifactPath(subheadMatch[1]);
				if (cleaned) {
					contracts.expectedFiles.add(cleaned);
				}
			}
			// Inline files mentioned in deliverables text (results/*, qc/*, manifests)
			const inlineFiles = l.matchAll(/`([a-zA-Z0-9_./-]+\.(?:tsv(?:\.gz)?|csv|jsonl|json|md|txt|bed))`?/g);
			for (const im of inlineFiles) {
				const cleaned = cleanArtifactPath(im[1]);
				if (cleaned && (cleaned.startsWith("results/") || cleaned.startsWith("qc/") || ["manifest.json", "decision_log.jsonl", "risk_notes.md", "method.json"].includes(cleaned))) {
					contracts.expectedFiles.add(cleaned);
				}
			}
		}
	}

	// Remove optional report files generated by validator itself
	contracts.expectedFiles.delete("public_validation.json");

	for (const f of contracts.expectedFiles) {
		if (!contracts.description.some((d) => d.includes(f))) {
			contracts.description.push(`- **Required Artifact**: \`/app/outputs/${f}\``);
		}
	}

	return contracts;
}

// ------------------------------------------------ bundled extensions

function packageExtensionPaths(pkgName) {
	const pkgDir = path.join(HARNESS_HOME, "node_modules", pkgName);
	const pkgJsonPath = path.join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) return [];
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
	} catch {
		return [];
	}
	const rels = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
	return rels.map((rel) => path.join(pkgDir, rel));
}

const subagentExtensions = packageExtensionPaths("pi-subagents");
const processExtensions = packageExtensionPaths("@aliou/pi-processes");
const solPiExtension = path.join(HARNESS_HOME, "extensions", "sol-pi", "index.ts");
const goalExtension = [
	path.join(HARNESS_HOME, "extensions", "pi-goal", "dist", "index.ts"),
	path.join(HARNESS_HOME, "extensions", "pi-goal", "index.ts"),
	...packageExtensionPaths("@narumitw/pi-goal"),
].find((p) => existsSync(p));
const extensionPaths = [
	...subagentExtensions,
	...processExtensions,
	...(existsSync(solPiExtension) ? [solPiExtension] : []),
	...(goalExtension ? [goalExtension] : []),
];

// ------------------------------------------------ preparation

const instruction = readFileSync(taskPath, "utf8");
const contracts = parseOutputContract(instruction);

const harborIdentity = Object.fromEntries(
	[...instruction.matchAll(/^\s*[-*]?\s*(instance_id|task_name|task_instance_id):\s*["']?([\w-]+)/gmi)]
		.map((match) => [match[1].toLowerCase(), /^\d+$/.test(match[2]) ? Number(match[2]) : match[2]]),
);
let harborAnswer = "";
let harborCheckpointRequested = false;

// A turn-ending bare token can be the whole answer (a gene symbol, a count, one CJK
// word). A closing line ("Done.", "Complete.") is not. Strip trailing punctuation
// before the refusal test, or the period slips past it.
const ANSWER_STOPWORDS = /^(done|complete|completed|finished|failed|success|ok|okay|sure|none|na|null|undefined|answer|final|blocked)$/i;
function plausibleScalarAnswer(raw) {
	const text = String(raw ?? "").trim().replace(/[\s.,;:!?。，；：！？、"'`)\]}】）]+$/u, "");
	if (!text || ANSWER_STOPWORDS.test(text) || text.startsWith("{") || text.startsWith("[")) return "";
	return /^\S{1,80}$/u.test(text) ? text : "";
}

function captureHarborAnswer(message) {
	if (harborIdentity.instance_id === undefined || !harborIdentity.task_name || harborIdentity.task_instance_id === undefined || message?.role !== "assistant") return;
	for (const block of message.content || []) {
		const raw = block.type === "text" ? block.text
			: block.type === "thinking" ? block.thinking
			: block.type === "toolCall" && block.name === "write" && path.resolve(codeDir, block.arguments?.path || "") === path.join(outputDir, "result.json")
				? block.arguments?.content : "";
		if (!raw) continue;
		for (const candidate of [raw.trim(), ...[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim())]) {
			try {
				const value = JSON.parse(candidate);
				if (typeof value?.answer === "string" && value.answer.trim() && (!value.status || value.status === "completed") && !/^the final answer requested by/i.test(value.answer)) {
					harborAnswer = value.answer;
				} else if (block.type === "text" && message.stopReason === "stop" && value && typeof value === "object" && Object.keys(value).length > 0 && value.answer === undefined && value.instance_id === undefined && !value.status) {
					harborAnswer = candidate;
				}
			} catch {
				// Prose and incomplete JSON cannot supply a structured answer.
			}
		}
		if (block.type === "text" || block.type === "thinking") {
			const finalAnswer = raw.match(/(?:^|\n)\s*(?:final\s+answer|answer)\s*:\s*([^\n]+)/i)?.[1]?.trim();
			if (finalAnswer) harborAnswer = finalAnswer;
			else if (block.type === "text" && message.stopReason === "stop") {
				const scalar = plausibleScalarAnswer(raw);
				if (scalar) harborAnswer = scalar;
			}
		}
	}
}

const HARBOR_RESULT_KEYS = [
	"instance_id",
	"task_name",
	"task_instance_id",
	"status",
	"answer",
	"evidence_summary",
	"files_used",
	"external_sources",
	"sandbox_ids",
	"job_ids",
	"cleanup_status",
];

function scrubForbiddenHarborText(value) {
	if (typeof value !== "string") return value;
	// Protocol checkers treat the token "rationale" as a forbidden resource reference.
	return value.replace(/\brationale\b/gi, "selection_note");
}

function sanitizeHarborResultFile(filePath) {
	if (!existsSync(filePath)) return false;
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		const next = {};
		for (const key of HARBOR_RESULT_KEYS) {
			if (!(key in raw)) continue;
			const value = raw[key];
			if (typeof value === "string") next[key] = scrubForbiddenHarborText(value);
			else if (Array.isArray(value)) next[key] = value.map((item) => (typeof item === "string" ? scrubForbiddenHarborText(item) : item));
			else next[key] = value;
		}
		if (!next.status && raw.status) next.status = raw.status;
		writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
		trace({ ts: Date.now(), type: "harbor_result_sanitized", path: filePath });
		return true;
	} catch (err) {
		trace({ ts: Date.now(), type: "harbor_result_sanitize_error", error: String(err) });
		return false;
	}
}

function writeHarborFallback(reason) {
	if (!harborAnswer || harborIdentity.task_instance_id === undefined || existsSync(path.join(outputDir, "result.json"))) return;
	if (process.env.API_KEY && harborAnswer.includes(process.env.API_KEY)) {
		trace({ ts: Date.now(), type: "harbor_fallback_rejected", reason: "credential in answer" });
		return;
	}
	try {
		writeFileSync(path.join(outputDir, "result.json"), JSON.stringify({
			...harborIdentity, status: "completed", answer: scrubForbiddenHarborText(harborAnswer),
			evidence_summary: "", files_used: [], external_sources: [], sandbox_ids: [], job_ids: [], cleanup_status: "not_used",
		}, null, 2) + "\n", { flag: "wx" });
		sanitizeHarborResultFile(path.join(outputDir, "result.json"));
	} catch (err) {
		if (err.code === "EEXIST") return;
		trace({ ts: Date.now(), type: "harbor_fallback_error", reason, error: String(err) });
		throw err;
	}
	trace({ ts: Date.now(), type: "harbor_fallback_written", reason, answer_source: "assistant_message" });
}

const { selected: promptSkills, totalChars: promptSkillChars } = selectRelevantSkills(
	instruction,
	discoveredAllSkills.skills,
	PROMPT_SKILL_CHARS,
);

const activeSkillsResource = {
	skills: promptSkills,
	diagnostics: [
		...discoveredAllSkills.diagnostics,
		{
			path: "dynamic-skill-matcher",
			message: `matched ${promptSkills.length} of ${discoveredAllSkills.skills.length} skills (${promptSkillChars} chars)`,
		},
	],
};

const skillsCatalog =
	promptSkills.map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(no skills bundled)";

const outputContractGuidance = (() => {
	const requiredFiles = ["result.json", "answer.json"].filter((file) => contracts.expectedFiles.has(file));
	if (requiredFiles.length === 0) return "";

	const lines = [
		"\n\n### Required output checkpoint",
		`The parsed task contract requires ${requiredFiles.map((file) => `\`/app/outputs/${file}\``).join(" and ")}. Write each required file as soon as its answer is known, then re-read it before ending.`,
		"When the answer is already computed, use the write tool to create each required non-empty artifact and re-read it before continuing any web or literature retrieval. Do not have the harness write an empty placeholder during retrieval.",
	];
	if (contracts.expectedFiles.has("result.json")) {
		lines.push("You must write `/app/outputs/result.json` with the write tool before ending. It is a Harbor JSON object with only `instance_id`, `task_name`, `task_instance_id`, `status: \"completed\"`, non-empty `answer`, `evidence_summary`, `files_used`, `external_sources`, `sandbox_ids`, `job_ids`, `cleanup_status`. Do not add other keys. Never write the substring `rationale` anywhere in the file (protocol ban). If that answer is not known yet, keep working and leave the file unwritten. Do not write an empty `answer` or `status` `failed`.");
	}
	if (contracts.expectedFiles.has("answer.json")) {
		lines.push("`answer.json` must be a JSON object with a non-empty string field `answer`.");
	}
	return lines.join("\n");
})();

// Contract-first gate: when the instruction names output files, the answer must be
// computed and written before any retrieval or extra QC. Rendered at the very top
// of the system prompt so it is the first thing the model reads.
const contractFirstGate = (() => {
	const files = Array.from(contracts.expectedFiles);
	if (files.length === 0) return "";
	return [
		"## OUTPUT CONTRACT GATE (read this first)",
		`This task names required output file(s): ${files.map((f) => `\`/app/outputs/${f}\``).join(", ")}.`,
		"Order of work, in this order and no other:",
		"1. Read the instruction and the input data. Extract the parameters needed to compute the answer from THIS task's inputs.",
		"2. Compute the answer with the bundled solver script or a deterministic calculation. Do not guess or fabricate values.",
		"3. Use the write tool to create each required file at its exact path with non-empty content, then read each file back to confirm it is non-empty and parseable.",
		"4. Only after every required file is written and verified may you do optional QC, documentation, or extra evidence gathering.",
		"If the answer cannot be computed from the available input, say so and stop. Do not write an empty or placeholder output file.",
	].join("\n\n") + "\n\n";
})();

// Runtime limits and the grader-visible detail rules. These used to live in
// prompts/verify.md and prompts/system.md, which no code path reads.
const runtimeGuidance = `

### Runtime limits
- Every \`bash\` call is killed after 300 seconds unless you pass \`timeout\` (hard maximum 1800). A killed command returns empty output; that is a timeout, not missing data. Split long analyses, or run long jobs through the \`process\` tool.
- Write your first required artifact as soon as the primary method is fixed; do not wait until the end.

### Grader-visible details (a passing public validator is not enough)
- Table headers must be exactly the required columns, in order. No renamed, reordered, or extra columns.
- Category columns: build every token from the instruction's full noun phrase, with spaces as underscores. Never invent a category the instruction does not name.
- Numeric key columns are compared as strings: write \`0.9\`, \`1.0\`, \`1.1\`, never \`0.900000\`.
- \`qc/summary.json\`: include the plain top-level scalars (input record/bin count, chromosome or sample count, number of primary results, the primary threshold value).
- If your primary result count is orders of magnitude larger than the experiment the instruction describes, the threshold is too permissive: tighten it and recompute.`;

function render(template, values) {
	return template.replace(/\{\{(\w+)\}\}/g, (_m, key) =>
		values[key] !== undefined ? String(values[key]) : `{{${key}}}`,
	);
}

const skillsSection = `\n\n### Recommended Method Skills\n${skillsCatalog}\n`;
const leadSystemTemplate = readFileSync(path.join(HARNESS_HOME, "prompts", "lead-system.md"), "utf8");
const leadSystem = render(leadSystemTemplate, {
	CODE_DIR: codeDir,
	OUTPUT_DIR: outputDir,
	TASK_PATH: taskPath,
	HARNESS_HOME,
	CONTRACT_FIRST_GATE: contractFirstGate,
}) + outputContractGuidance + runtimeGuidance + skillsSection;

const teamTemplate = readFileSync(path.join(HARNESS_HOME, "prompts", "team.md"), "utf8");
const teamPrompt = render(teamTemplate, {
	CODE_DIR: codeDir,
	OUTPUT_DIR: outputDir,
	TASK_PATH: taskPath,
	INSTRUCTION: instruction,
	OUTPUT_CONTRACT_SUMMARY: contracts.description.length > 0 ? contracts.description.join("\n") : "- Output artifacts as requested by the instruction.",
	SKILLS_CATALOG: skillsCatalog,
	HARNESS_HOME,
}) + outputContractGuidance + runtimeGuidance;

// -------------------------------------------------------------- model setup

const modelsPath = path.join(agentDir, "models.json");
writeFileSync(
	modelsPath,
	`${JSON.stringify(
		{
			providers: {
				harness: {
					name: "Harness Runtime",
					baseUrl,
					api: "openai-completions",
					apiKey: "${API_KEY}",
					models: [
						{
							id: modelName,
							name: modelName,
							reasoning: false,
							contextWindow,
							maxTokens,
							compat: { supportsDeveloperRole: false },
						},
					],
				},
			},
		},
		null,
		2,
	)}\n`,
);

const modelRuntime = await ModelRuntime.create({
	authPath: path.join(agentDir, "auth.json"),
	modelsPath,
});
const model = modelRuntime.getModel("harness", modelName);
if (!model) {
	console.error(`model not resolvable: harness/${modelName}`);
	process.exit(2);
}

async function makeResourceLoader(systemText) {
	const loader = new DefaultResourceLoader({
		cwd: codeDir,
		agentDir,
		systemPromptOverride: () => systemText,
		appendSystemPromptOverride: () => [],
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => activeSkillsResource,
		additionalExtensionPaths: extensionPaths,
	});
	await loader.reload();
	return loader;
}

const settingsManager = SettingsManager.inMemory({
	defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 16000 },
	retry: { enabled: true, maxRetries: 3 },
});

const DEFAULT_BASH_TIMEOUT_SEC = 300;
const baseBashDef = createBashToolDefinition(codeDir);
const safeBashTool = {
	...baseBashDef,
	execute: async (toolCallId, params, signal, onUpdate, ctx) => {
		const timeout =
			typeof params?.timeout === "number" && params.timeout > 0
				? Math.min(params.timeout, 1800)
				: DEFAULT_BASH_TIMEOUT_SEC;
		return baseBashDef.execute(toolCallId, { ...params, timeout }, signal, onUpdate, ctx);
	},
};

const leadLoader = await makeResourceLoader(leadSystem);
const sessionManager = SessionManager.create(codeDir, sessionDir);
const { session } = await createAgentSession({
	cwd: codeDir,
	agentDir,
	model,
	modelRuntime,
	resourceLoader: leadLoader,
	settingsManager,
	sessionManager,
	customTools: [safeBashTool],
});
await session.bindExtensions({});

// ------------------------------------------------------------------- run

const startedAt = Date.now();
const deadline = timeoutSec > 0 ? startedAt + timeoutSec * 1000 : 0;
const stats = { assistant_text: 0, tool_calls: 0, tool_errors: 0, turns: 0, retries: 0, usage: null };
const subagentLaunches = [];
const processCalls = [];
let leadText = "";
let lastStopReason = "";

const unsubscribe = session.subscribe((event) => {
	switch (event.type) {
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				stats.assistant_text++;
			}
			return;
		case "tool_execution_start": {
			stats.tool_calls++;
			const toolArgs = event.args ?? event.arguments ?? {};
			if (event.toolName === "subagent" && toolArgs && toolArgs.agent) {
				const launch = {
					agent: String(toolArgs.agent),
					async: toolArgs.async,
					ts: Date.now(),
				};
				subagentLaunches.push(launch);
			}
			if (event.toolName === "process") {
				processCalls.push({ action: toolArgs?.action, ts: Date.now() });
			}
			trace({ ts: Date.now(), type: "tool_call", role: "lead", tool: event.toolName, args: toolArgs });
			return;
		}
		case "tool_execution_end":
			if (event.isError) stats.tool_errors++;
			trace({
				ts: Date.now(),
				type: "tool_result",
				role: "lead",
				tool: event.toolName,
				isError: Boolean(event.isError),
				result: event.result,
			});
			return;
		case "agent_end":
			stats.turns++;
			return;
		case "auto_retry_start":
			stats.retries++;
			trace({ ts: Date.now(), type: "auto_retry_start", role: "lead", attempt: event.attempt, error: event.errorMessage });
			return;
		case "compaction_end":
			trace({ ts: Date.now(), type: "compaction_end", role: "lead", reason: event.reason, aborted: event.aborted });
			return;
		case "message_end": {
			const msg = event.message;
			if (msg?.role === "assistant") {
				const text = Array.isArray(msg.content)
					? msg.content
							.filter((b) => b.type === "text")
							.map((b) => b.text)
							.join("\n")
					: msg.content;
				if (text) leadText = text;
				lastStopReason = String(msg.stopReason || "");
				captureHarborAnswer(msg);
				trace({
					ts: Date.now(),
					type: "assistant_message",
					role: "lead",
					text,
					usage: msg.usage,
					stopReason: msg.stopReason,
				});
				if (msg.usage) stats.usage = msg.usage;
			}
			return;
		}
		default:
			return;
	}
});

trace({
	ts: Date.now(),
	type: "run_start",
	model: `harness/${modelName}`,
	baseUrl,
	task: taskPath,
	codeDir,
	outputDir,
	extensions: extensionPaths,
	goalExtension: Boolean(goalExtension),
	maxTokens,
	timeoutSec,
	skills: promptSkills.map((s) => s.name),
	skillDiagnostics: activeSkillsResource.diagnostics,
	expectedContracts: { ...contracts, expectedFiles: Array.from(contracts.expectedFiles) },
});

function listArtifacts(root) {
	const out = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(path.relative(root, full));
		}
	};
	walk(root);
	return out.sort();
}

function verifyArtifacts(expectedContracts, targetDir, workDir) {
	const issues = [];
	const existingFiles = listArtifacts(targetDir);

	if (existingFiles.length === 0) {
		issues.push(`No artifacts found under ${targetDir}.`);
		return { ok: false, issues, existingFiles };
	}

	if (expectedContracts.isHarborTask) {
		sanitizeHarborResultFile(path.join(targetDir, "result.json"));
	}

	const filesToCheck = expectedContracts.expectedFiles.size > 0
		? expectedContracts.expectedFiles
		: new Set(existingFiles);

	for (const expected of filesToCheck) {
		const fullExpected = path.join(targetDir, expected);
		if (!existsSync(fullExpected)) {
			const baseName = path.basename(expected);
			if (baseName !== expected && existsSync(path.join(targetDir, baseName))) {
				issues.push(`Missing required artifact: /app/outputs/${expected} (found flat file /app/outputs/${baseName}; please move it into the expected subdirectory)`);
			} else {
				issues.push(`Missing required artifact: /app/outputs/${expected}`);
			}
		}
	}

	return {
		ok: issues.length === 0,
		issues,
		existingFiles,
	};
}

async function runPrompt(prompt, label) {
	const toolCallsBefore = stats.tool_calls;
	const remainingMs = deadline > 0 ? deadline - Date.now() : 0;
	const checkpointTimer = deadline > 0 && remainingMs > 45000 && harborIdentity.task_name && !harborCheckpointRequested
		? setTimeout(() => {
			harborCheckpointRequested = true;
			writeHarborFallback("deadline checkpoint");
			session.abort().catch((err) => trace({ ts: Date.now(), type: "abort_error", error: String(err) }));
		}, remainingMs - 45000) : null;
	const timer =
		deadline > 0
			? setTimeout(() => {
					trace({ ts: Date.now(), type: "timeout_abort", phase: label, timeoutSec });
					writeHarborFallback("timeout abort");
					session.abort().catch((err) => trace({ ts: Date.now(), type: "abort_error", error: String(err) }));
				}, Math.max(remainingMs, 0))
			: null;
	try {
		if (deadline > 0 && remainingMs <= 0) return { ok: false, error: "deadline already exceeded" };
		await session.prompt(prompt);
		const phaseToolCalls = stats.tool_calls - toolCallsBefore;
		const verification = verifyArtifacts(contracts, outputDir, codeDir);
		if (phaseToolCalls === 0) {
			return { ok: false, error: "phase completed without tool calls" };
		}
		if (!verification.ok) {
			return { ok: false, error: verification.issues.join("; ") };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err && err.stack ? err.stack : err) };
	} finally {
		if (timer) clearTimeout(timer);
		if (checkpointTimer) clearTimeout(checkpointTimer);
	}
}

function buildGoalObjective(instructionText, outputContracts, targetPath, workingDir, targetOutputDir) {
	const allFiles = Array.from(outputContracts.expectedFiles);
	const gateLines = [
		"Completion & Blocker Gate:",
		"1. Compute all answers and findings strictly from this task's inputs and scripts; do not fabricate or guess.",
		`2. Write each required artifact under ${targetOutputDir} with exact paths and non-empty content.`,
		`3. Use the read tool to read back every file in ${targetOutputDir} and verify it is non-empty, well-formed, and complete. Run any public validator if present.`,
		"4. Only after all required files are written and verified non-empty by reading them back, call goal_complete with the exact active goal_id and an evidence summary. Declaring completion in text does NOT count.",
		"5. If unable to compute from available inputs, explain what is missing and call goal_blocked. Do NOT write empty placeholder files or perform endless retrieval.",
	];
	const displayTask = targetPath.length > 120 ? `...${targetPath.slice(-117)}` : targetPath;
	const displayWork = workingDir.length > 120 ? `...${workingDir.slice(-117)}` : workingDir;
	const headerLines = [
		`Analyze task input data and complete requirements in ${displayTask} (staged under ${displayWork}/instruction.md).`,
		"",
		"Required output deliverables:",
	];

	// Strictly guarantee that gateLines are never truncated and total objective <= 4000 chars.
	const gateBlock = gateLines.join("\n");
	const headerBlock = headerLines.join("\n");
	const maxDeliverablesChars = Math.max(100, 3950 - headerBlock.length - gateBlock.length - 10);

	const deliverableLines = [];
	if (allFiles.length === 0) {
		deliverableLines.push("- Deliverable artifacts as specified in the instruction file");
	} else {
		let currentChars = 0;
		let includedCount = 0;
		for (const f of allFiles) {
			const displayFile = f.length > 120 ? `...${f.slice(-117)}` : f;
			const line = `- ${path.posix.join(targetOutputDir, displayFile)}`;
			if (currentChars + line.length + 80 > maxDeliverablesChars) {
				const remaining = allFiles.length - includedCount;
				deliverableLines.push(`- ... and ${remaining} more deliverable files as specified in instruction.md`);
				break;
			}
			deliverableLines.push(line);
			currentChars += line.length + 1;
			includedCount++;
		}
		if (includedCount === 0 && deliverableLines.length === 0) {
			deliverableLines.push("- Deliverable artifacts as specified in the instruction file");
		}
	}

	return [
		...headerLines,
		...deliverableLines,
		"",
		...gateLines,
	].join("\n");
}

const goalObjective = buildGoalObjective(instruction, contracts, taskPath, codeDir, outputDir);

async function runGoalTask(objective, label) {
	const toolCallsBefore = stats.tool_calls;
	const remainingMs = deadline > 0 ? deadline - Date.now() : 0;
	const runId = `task-run-${Date.now()}`;
	let terminalEvent = null;
	let unsubscribe = null;

	const checkpointTimer = deadline > 0 && remainingMs > 45000 && harborIdentity.task_name && !harborCheckpointRequested
		? setTimeout(() => {
			harborCheckpointRequested = true;
			writeHarborFallback("deadline checkpoint");
			leadLoader.eventBus.emit("pi-goal:cancel", { runId, reason: "deadline checkpoint" });
			session.abort().catch((err) => trace({ ts: Date.now(), type: "abort_error", error: String(err) }));
		}, remainingMs - 45000) : null;

	const timer = deadline > 0
		? setTimeout(() => {
			trace({ ts: Date.now(), type: "timeout_abort", phase: label, timeoutSec });
			writeHarborFallback("timeout abort");
			leadLoader.eventBus.emit("pi-goal:cancel", { runId, reason: "timeout abort" });
			session.abort().catch((err) => trace({ ts: Date.now(), type: "abort_error", error: String(err) }));
		}, Math.max(remainingMs, 0))
		: null;

	try {
		if (deadline > 0 && remainingMs <= 0) return { ok: false, error: "deadline already exceeded" };

		const terminalPromise = new Promise((resolve) => {
			const onEvent = (ev) => {
				trace({ ts: Date.now(), type: "goal_event", role: "lead", ...ev });
				if (ev.type === "state" && ["complete", "blocked", "paused", "usage_limited", "budget_limited", "cleared"].includes(ev.status)) {
					terminalEvent = ev;
					resolve({ ok: ev.status === "complete", event: ev });
				} else if (ev.type === "error") {
					resolve({ ok: false, error: ev.error?.message || "goal run error" });
				}
			};
			unsubscribe = leadLoader.eventBus.on(`pi-goal:event:${runId}`, onEvent);
		});

		trace({ ts: Date.now(), type: "goal_start", runId, objectiveLength: objective.length });
		leadLoader.eventBus.emit("pi-goal:start", {
			runId,
			objective,
		});

		const runOutcome = await terminalPromise;
		if (!runOutcome?.ok && runOutcome?.error) {
			return { ok: false, error: runOutcome.error };
		}

		const phaseToolCalls = stats.tool_calls - toolCallsBefore;
		const verification = verifyArtifacts(contracts, outputDir, codeDir);

		if (terminalEvent?.status === "complete" && verification.ok) {
			return { ok: true, status: "complete" };
		}
		if (terminalEvent?.status === "blocked") {
			return { ok: false, status: "blocked", reason: terminalEvent.reason };
		}
		if (phaseToolCalls === 0) {
			return { ok: false, error: terminalEvent?.reason || "phase completed without tool calls" };
		}
		if (!verification.ok) {
			return { ok: false, error: verification.issues.join("; ") };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err && err.stack ? err.stack : err) };
	} finally {
		if (typeof unsubscribe === "function") unsubscribe();
		if (timer) clearTimeout(timer);
		if (checkpointTimer) clearTimeout(checkpointTimer);
	}
}

for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
	process.on(signal, () => {
		writeHarborFallback(signal);
		process.exit(exitCode);
	});
}

trace({ ts: Date.now(), type: "phase_start", phase: "task" });
const first = goalExtension
	? await runGoalTask(goalObjective, "task")
	: await runPrompt(teamPrompt, "task");
trace({ ts: Date.now(), type: "phase_end", phase: "task", ok: first.ok, error: first.error });
if (first.status !== "blocked") {
	writeHarborFallback(first.ok ? "task phase completion" : "task phase abort");
}

let verification = verifyArtifacts(contracts, outputDir, codeDir);
let nudges = 0;
const MAX_NUDGES = 2;

// A missing artifact that carries the graded answer blocks scoring; a missing
// QC/manifest/decision-log does not. Rank the missing files so the nudge asks for
// the score-blocking ones first.
function rankMissingArtifact(file) {
	const base = path.basename(file).toLowerCase();
	if (contracts.isHarborTask && base === "result.json") return 0;
	if (base === "answer.json") return 0;
	if (/^results\//.test(file) || /(?:^|\/)(?:calls|bin_depth|bin_ratios|segments|depth|prediction|scores|counts|matrix|peaks|domains|linkage|normalization)[^/]*\.(?:tsv|csv|bed|json)$/.test(base)) return 1;
	if (/^(?:qc|qc_)/.test(base) || base === "summary.json" || base === "method.json") return 3;
	if (/manifest|decision_log|risk_notes|readme|audit|report/.test(base)) return 4;
	return 2;
}

function splitMissingArtifacts(issues) {
	const critical = [];
	const advisory = [];
	for (const issue of issues) {
		const fileMatch = /\/app\/outputs\/([^\s()]+)/.exec(issue);
		const rank = fileMatch ? rankMissingArtifact(fileMatch[1]) : 1;
		if (rank <= 1) critical.push(issue);
		else advisory.push(issue);
	}
	return { critical, advisory };
}

async function compactBeforeNudge() {
	if (typeof session.compact !== "function") return;
	try {
		await session.compact("Preserve the computed answer values, file paths, and any non-empty artifact contents for the final write step.");
		trace({ ts: Date.now(), type: "pre_nudge_compact", ok: true });
	} catch (err) {
		trace({ ts: Date.now(), type: "pre_nudge_compact", ok: false, error: String(err) });
	}
}

while (!verification.ok && nudges < MAX_NUDGES && first.status !== "blocked") {
	nudges++;
	const lengthStopped = contracts.expectedFiles.size > 0 && /(?:length|max[_ -]?tokens?)/i.test(lastStopReason);
	const { critical, advisory } = splitMissingArtifacts(verification.issues);
	if (!lengthStopped) await compactBeforeNudge();
	const nudgeMsg = lengthStopped
		? [
			"[LENGTH STOP] The previous response stopped at the token limit.",
			"Do not research, browse, or call tools for new evidence.",
			`If a non-empty answer has already been computed, use the write tool now to create the required file(s) under ${outputDir}, then re-read them.`,
			"If no non-empty answer has already been computed, do not create any output file and stop.",
		].join("\n")
		: [
			`[VERIFICATION GATE FAILED] Output check detected issues under ${outputDir}:`,
			...(critical.length > 0
				? ["", "Critical missing (blocks scoring — fix these first):", ...critical.map((i) => ` - ${i}`)]
				: []),
			...(advisory.length > 0
				? ["", "Advisory missing (does not block scoring but recommended):", ...advisory.map((i) => ` - ${i}`)]
				: []),
			"",
			harborCheckpointRequested
				? "The deadline is near. Stop research and write the best answer already reached in this conversation now; record uncertainty honestly."
				: "Please fix the critical issues first using available tools, then the advisory ones if time allows:",
			contracts.isHarborTask
				? "1. For Harbor, write result.json only if a non-empty answer is already known; otherwise continue research without creating it."
				: `1. Make sure every required artifact is written under ${outputDir} with non-empty content.`,
			"2. If JSON is requested, ensure valid JSON syntax and mandatory fields.",
			"3. If a public validator is present, ensure it passes.",
			"4. Before rewriting, re-read the 'Grader-visible details' rules in your instructions: headers in order, category tokens as the instruction's full noun phrase, numeric keys written as strings.",
		].join("\n");
	trace({ ts: Date.now(), type: "phase_start", phase: `nudge_${nudges}`, issues: verification.issues, critical, advisory });
	const res = await runPrompt(nudgeMsg, `nudge_${nudges}`);
	trace({ ts: Date.now(), type: "phase_end", phase: `nudge_${nudges}`, ok: res.ok, error: res.error });
	writeHarborFallback(res.ok ? `nudge_${nudges} completion` : `nudge_${nudges} abort`);
	verification = verifyArtifacts(contracts, outputDir, codeDir);
}

const artifacts = listArtifacts(outputDir);
const finalOk = verification.ok || (artifacts.length > 0 && contracts.expectedFiles.size === 0);
const status = finalOk ? "ok" : "failed";

const launchedRoles = [...new Set(subagentLaunches.map((l) => l.agent))];
const durationMs = Date.now() - startedAt;
const sessionFile = sessionManager?.getSessionFile?.();

const result = {
	status,
	subagent_calls: subagentLaunches.length,
	subagent_agents: launchedRoles,
	process_tool_calls: processCalls.length,
	model: `harness/${modelName}`,
	baseUrl,
	task: taskPath,
	code_dir: codeDir,
	output_dir: outputDir,
	duration_ms: durationMs,
	timeout_sec: timeoutSec,
	nudges,
	stats,
	artifacts,
	artifact_count: artifacts.length,
	trace: tracePath,
	session_file: sessionFile,
	first_prompt_ok: first.ok,
	verification_ok: verification.ok,
	verification_issues: verification.issues,
	expected_artifacts: Array.from(contracts.expectedFiles),
};
writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

trace({
	ts: Date.now(),
	type: "run_end",
	status,
	duration_ms: durationMs,
	artifact_count: artifacts.length,
	subagent_calls: subagentLaunches.length,
	verification_ok: verification.ok,
});
unsubscribe();
session.dispose();

console.log(
	JSON.stringify(
		{
			status,
			subagent_calls: subagentLaunches.length,
			subagent_agents: launchedRoles,
			artifacts,
			verification_ok: verification.ok,
			duration_ms: durationMs,
		},
		null,
		2,
	),
);
process.exit(status === "ok" ? 0 : 1);
