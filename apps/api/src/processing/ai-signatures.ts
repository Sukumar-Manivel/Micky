// Finds the labels that AI generators write into their own output files.
//
// AI image and video tools increasingly label what they make, in three ways:
//   1. The industry-standard "digital source type" label, written by Google (Gemini/Imagen),
//      OpenAI (ChatGPT, DALL·E, Sora), Adobe Firefly, Meta AI, Microsoft and others, either
//      inside C2PA Content Credentials or in IPTC/XMP metadata:
//        http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia
//      ("compositeWithTrainedAlgorithmicMedia" = a real photo edited with generative AI).
//   2. The generator's name in EXIF/XMP/QuickTime "Software", "CreatorTool" or similar tags.
//   3. Generation settings saved by open-source tools: AUTOMATIC1111/Forge write a PNG text
//      chunk with "Steps: …, Sampler: …, CFG scale: …"; ComfyUI saves its whole workflow.
//
// All of these sit in a file's metadata, which lives near the start of photos and PNGs and at
// the start or end of MP4/MOV files. So we scan the first and last few megabytes as bytes:
// no decoding, no heavy model, milliseconds per file.
//
// A match is strong evidence (a camera never writes "Midjourney"). No match proves nothing:
// labels are easy to strip (a screenshot, WhatsApp, a re-encode), which is why the AI model
// and a human reviewer are still needed. See docs/learning/media-and-processing.md.
import { open } from 'node:fs/promises';

/** How many bytes to read from each end of the file. */
export const SCAN_BYTES = 8 * 1024 * 1024;

export interface AiSignature {
  /** Human-readable name of the tool, for the admin. */
  tool: string;
  /** 'generated': made by AI. 'edited': a real capture changed with generative AI. */
  kind: 'generated' | 'edited';
  /** The exact text found, so an admin can verify it in the raw metadata. */
  evidence: string;
}

interface Rule {
  tool: string;
  kind: AiSignature['kind'];
  /** Lower-case byte strings; long and specific enough not to occur by chance. */
  patterns: string[];
}

// Order matters only for reporting: the "edited" label must be checked before the
// "generated" one, because its text contains the other ("compositeWith|trainedAlgorithmicMedia").
const RULES: Rule[] = [
  {
    tool: 'a generative AI editing tool (labelled "composite with trained algorithmic media")',
    kind: 'edited',
    patterns: ['compositewithtrainedalgorithmicmedia'],
  },
  {
    tool: 'an AI generator (labelled "trained algorithmic media")',
    kind: 'generated',
    patterns: ['/trainedalgorithmicmedia', '"trainedalgorithmicmedia', '>trainedalgorithmicmedia', 'digitalsourcetype=trainedalgorithmicmedia'],
  },
  { tool: 'Midjourney', kind: 'generated', patterns: ['midjourney'] },
  {
    tool: 'Stable Diffusion',
    kind: 'generated',
    patterns: ['stable diffusion', 'stablediffusion', 'automatic1111', 'sd-webui', 'stable-diffusion-webui'],
  },
  { tool: 'ComfyUI (Stable Diffusion / Flux)', kind: 'generated', patterns: ['comfyui', '"class_type"'] },
  { tool: 'DALL·E / ChatGPT (OpenAI)', kind: 'generated', patterns: ['dall-e', 'dall\u00e2\u00b7e', 'dall\u00b7e', 'chatgpt', 'openai'] },
  { tool: 'Adobe Firefly', kind: 'generated', patterns: ['adobe firefly', 'adobe_firefly'] },
  { tool: 'Google AI (Gemini / Imagen)', kind: 'generated', patterns: ['made with google ai', 'synthid'] },
  { tool: 'Meta AI', kind: 'generated', patterns: ['imagined with ai'] },
  {
    tool: 'Microsoft Designer / Bing Image Creator',
    kind: 'generated',
    patterns: ['microsoft designer', 'bing image creator', 'image creator from microsoft'],
  },
  { tool: 'NovelAI', kind: 'generated', patterns: ['novelai'] },
  { tool: 'Leonardo.Ai', kind: 'generated', patterns: ['leonardo.ai'] },
  { tool: 'Ideogram', kind: 'generated', patterns: ['ideogram'] },
  { tool: 'Flux (Black Forest Labs)', kind: 'generated', patterns: ['black forest labs', 'black-forest-labs'] },
  { tool: 'Runway', kind: 'generated', patterns: ['runwayml', 'runway gen-'] },
  { tool: 'Kling AI', kind: 'generated', patterns: ['klingai', 'kling ai'] },
  { tool: 'Luma Dream Machine', kind: 'generated', patterns: ['lumalabs', 'dream machine'] },
  { tool: 'Pika', kind: 'generated', patterns: ['pika labs', 'pika.art'] },
];

/** AUTOMATIC1111-style generation parameters (a PNG "parameters" text chunk). */
const SD_PARAMETERS = /steps: ?\d+, ?sampler: ?[^,]{2,40}, ?(cfg scale|schedule type)/;

/**
 * Scans raw bytes (the start and end of a file) plus any extra metadata strings
 * (EXIF Software, ffprobe tags, the C2PA claim generator) for AI-generator labels.
 * Pure function: no I/O, deterministic, unit tested in ai-signatures.spec.ts.
 */
export function scanAiSignatures(chunks: readonly Buffer[], extraText: readonly (string | null | undefined)[] = []): AiSignature[] {
  // latin1 maps every byte to one character, so byte strings can be searched as text.
  const haystack = [...chunks.map((c) => c.toString('latin1')), ...extraText.filter(Boolean)].join('\n').toLowerCase();
  const found: AiSignature[] = [];
  let sawEdited = false;
  for (const rule of RULES) {
    const pattern = rule.patterns.find((p) => haystack.includes(p));
    if (!pattern) continue;
    if (rule.kind === 'edited') sawEdited = true;
    // An "edited" label also contains the "generated" label's text: report only the edit.
    if (sawEdited && rule.kind === 'generated' && rule.patterns.some((p) => p.includes('trainedalgorithmicmedia'))) continue;
    found.push({ tool: rule.tool, kind: rule.kind, evidence: excerpt(haystack, pattern) });
  }
  const sd = SD_PARAMETERS.exec(haystack);
  if (sd && !found.some((s) => s.tool === 'Stable Diffusion')) {
    found.push({ tool: 'Stable Diffusion', kind: 'generated', evidence: sd[0] });
  }
  return found;
}

/** Reads the first and last SCAN_BYTES of a file (once, if the file is small). */
export async function readHeadAndTail(file: string, bytes = SCAN_BYTES): Promise<Buffer[]> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= 2 * bytes) {
      const all = Buffer.alloc(size);
      await handle.read(all, 0, size, 0);
      return [all];
    }
    const head = Buffer.alloc(bytes);
    const tail = Buffer.alloc(bytes);
    await handle.read(head, 0, bytes, 0);
    await handle.read(tail, 0, bytes, size - bytes);
    return [head, tail];
  } finally {
    await handle.close();
  }
}

/** The matched text with a little context, printable characters only. */
function excerpt(haystack: string, pattern: string): string {
  const at = haystack.indexOf(pattern);
  const raw = haystack.slice(Math.max(0, at - 20), at + pattern.length + 40);
  return raw.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}
