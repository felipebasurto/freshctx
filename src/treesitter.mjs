import { fileURLToPath } from "node:url";

import { Language, Parser } from "../vendor/treesitter/web-tree-sitter.js";

const LANGUAGE_BY_EXTENSION = new Map([
  [".py", "python"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".go", "go"],
  [".rs", "rust"],
]);

const GRAMMAR_FILE = Object.freeze({
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
});

const DECLARATIONS = new Set([
  "class_definition",
  "class_declaration",
  "abstract_class_declaration",
  "function_definition",
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "method_declaration",
  "function_item",
]);

const CLASS_TYPES = new Set(["class_definition", "class_declaration", "abstract_class_declaration"]);
const METHOD_TYPES = new Set(["method_definition", "method_declaration"]);
const FUNCTION_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "generator_function_declaration",
  "function_item",
]);

const SCOPE_TYPES = new Map([
  ["class_definition", "class"],
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["impl_item", "class"],
  ["function_definition", "function"],
  ["function_declaration", "function"],
  ["generator_function_declaration", "function"],
  ["function_item", "function"],
  ["method_definition", "method"],
  ["method_declaration", "method"],
]);

const BLOCK_TYPES = new Map([
  ["if_statement", "if"],
  ["if_expression", "if"],
  ["elif_clause", "elif"],
  ["else_clause", "else"],
  ["for_statement", "for"],
  ["for_in_statement", "for"],
  ["for_expression", "for"],
  ["while_statement", "while"],
  ["while_expression", "while"],
  ["loop_expression", "loop"],
  ["with_statement", "with"],
  ["match_statement", "match"],
  ["match_expression", "match"],
  ["case_clause", "case"],
  ["match_arm", "case"],
  ["try_statement", "try"],
  ["except_clause", "except"],
  ["catch_clause", "except"],
  ["finally_clause", "finally"],
  ["switch_statement", "switch"],
  ["expression_switch_statement", "switch"],
  ["type_switch_statement", "switch"],
  ["switch_case", "case"],
]);

let runtimeReady = null;
const languages = new Map();

function vendorPath(file) {
  return fileURLToPath(new URL(`../vendor/treesitter/${file}`, import.meta.url));
}

function extensionOf(sourcePath) {
  const slash = sourcePath.lastIndexOf("/");
  const filename = sourcePath.slice(slash + 1).toLowerCase();
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot);
}

export function languageForPath(sourcePath) {
  return LANGUAGE_BY_EXTENSION.get(extensionOf(sourcePath)) ?? null;
}

export const supportedLanguages = Object.freeze([...new Set(LANGUAGE_BY_EXTENSION.values())]);

async function initializeRuntime() {
  if (!runtimeReady) {
    runtimeReady = Parser.init();
  }
  await runtimeReady;
}

async function languageFor(language) {
  await initializeRuntime();
  if (!languages.has(language)) {
    const grammar = await Language.load(vendorPath(GRAMMAR_FILE[language]));
    languages.set(language, grammar);
  }
  return languages.get(language);
}

function namedChildren(node) {
  return node.namedChildren ?? [];
}

function scopeName(node) {
  if (node.type === "impl_item") return node.childForFieldName("type")?.text ?? null;
  return node.childForFieldName("name")?.text ?? null;
}

function isMethodLike(node) {
  if (METHOD_TYPES.has(node.type)) return true;
  if (!FUNCTION_TYPES.has(node.type)) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (CLASS_TYPES.has(parent.type) || parent.type === "impl_item") return true;
  }
  return false;
}

function kindFor(node) {
  if (CLASS_TYPES.has(node.type)) return "class";
  if (METHOD_TYPES.has(node.type)) return "method";
  if (FUNCTION_TYPES.has(node.type)) return isMethodLike(node) ? "method" : "function";
  return null;
}

function siblingIndex(node) {
  const parent = node.parent;
  if (!parent) return null;
  const siblings = namedChildren(parent).filter((child) => child.type === node.type);
  if (siblings.length < 2) return null;
  const index = siblings.findIndex((child) => child.startIndex === node.startIndex && child.endIndex === node.endIndex);
  return index < 0 ? null : index;
}

function segmentForScope(node) {
  const baseKind = SCOPE_TYPES.get(node.type);
  if (!baseKind) return null;
  const kind = baseKind === "function" && isMethodLike(node) ? "method" : baseKind;
  const name = scopeName(node);
  return name ? `${kind} ${name}` : null;
}

function enclosingSelector(node) {
  const segments = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    const scope = segmentForScope(parent);
    if (scope) {
      segments.push(scope);
      continue;
    }
    const block = BLOCK_TYPES.get(parent.type);
    if (block) {
      const index = siblingIndex(parent);
      segments.push(index === null ? block : `${block}@${index}`);
    }
  }
  return segments.reverse();
}

function receiverType(node) {
  if (node.type !== "method_declaration") return null;
  const visit = (candidate) => {
    if (!candidate) return null;
    if (candidate.type === "type_identifier") return candidate.text;
    for (const child of candidate.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(node.childForFieldName("receiver"));
}

function qualifiedSelector(node, name, kind) {
  const segments = enclosingSelector(node);
  const receiver = receiverType(node);
  if (receiver && !segments.includes(`class ${receiver}`)) segments.unshift(`class ${receiver}`);
  segments.push(`${kind} ${name}`);
  return segments.join("::");
}

function inclusiveEndLine(node) {
  const { startPosition, endPosition } = node;
  return endPosition.column === 0 && endPosition.row > startPosition.row
    ? endPosition.row
    : endPosition.row + 1;
}

function collectDeclarations(node, output) {
  if (DECLARATIONS.has(node.type)) output.push(node);
  for (const child of namedChildren(node)) collectDeclarations(child, output);
}

class Utf16ToUtf8Index {
  constructor(offsets) {
    this.offsets = offsets;
  }

  // One cumulative walk so declaration offsets stay O(n) instead of O(n × decls).
  // Prefix slices keep BOM / lone-surrogate behavior identical to Buffer.byteLength.
  static fromText(text, indices) {
    const unique = [...new Set(indices)].sort((a, b) => a - b);
    const offsets = new Map();
    let previous = 0;
    let bytes = 0;
    for (const index of unique) {
      bytes += Buffer.byteLength(text.slice(previous, index), "utf8");
      offsets.set(index, bytes);
      previous = index;
    }
    return new Utf16ToUtf8Index(offsets);
  }

  byteOffset(stringIndex) {
    return this.offsets.get(stringIndex);
  }
}

function toUnit(sourcePath, language, text, node, index) {
  if (node.hasError || node.isMissing) return null;
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const kind = kindFor(node);
  if (!kind) return null;
  return {
    kind: "symbol",
    symbolKind: kind,
    path: sourcePath,
    language,
    selector: qualifiedSelector(node, name, kind),
    startLine: node.startPosition.row + 1,
    endLine: inclusiveEndLine(node),
    startByte: index.byteOffset(node.startIndex),
    endByte: index.byteOffset(node.endIndex),
  };
}

export async function parseUnits({ path, text }) {
  const language = languageForPath(path);
  if (!language) return { status: "unsupported", language: null, units: [] };
  let parser;
  let tree;
  try {
    const grammar = await languageFor(language);
    parser = new Parser();
    parser.setLanguage(grammar);
    tree = parser.parse(text);
    if (!tree || tree.rootNode.hasError) {
      return { status: "broken", language, units: [] };
    }
    const declarations = [];
    collectDeclarations(tree.rootNode, declarations);
    const index = Utf16ToUtf8Index.fromText(
      text,
      declarations.flatMap((node) => [node.startIndex, node.endIndex]),
    );
    const found = [];
    for (const node of declarations) {
      const unit = toUnit(path, language, text, node, index);
      if (!unit) continue;
      found.push(unit);
    }
    const selectorCounts = new Map();
    for (const unit of found) selectorCounts.set(unit.selector, (selectorCounts.get(unit.selector) ?? 0) + 1);
    const units = found.filter((unit) => selectorCounts.get(unit.selector) === 1);
    units.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte || left.selector.localeCompare(right.selector));
    return { status: "ok", language, units };
  } catch {
    return { status: "broken", language, units: [] };
  } finally {
    tree?.delete();
    parser?.delete();
  }
}

export async function uniqueUnitForRange({ path, text, range }) {
  const parsed = await parseUnits({ path, text });
  if (parsed.status !== "ok") return { ...parsed, unit: null };
  const matching = parsed.units.filter((unit) => range.startByte >= unit.startByte && range.endByte <= unit.endByte);
  if (matching.length === 0) return { ...parsed, unit: null };
  matching.sort((left, right) => (left.endByte - left.startByte) - (right.endByte - right.startByte) || left.selector.localeCompare(right.selector));
  const smallest = matching[0];
  if (matching.length > 1 && matching[1].endByte - matching[1].startByte === smallest.endByte - smallest.startByte) {
    return { ...parsed, unit: null, ambiguous: true };
  }
  return { ...parsed, unit: smallest };
}

export async function verifyTreeSitterAssets() {
  await Promise.all(supportedLanguages.map((language) => languageFor(language)));
  return [...supportedLanguages];
}
