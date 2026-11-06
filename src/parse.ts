import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Code, Html } from "mdast";

export interface Element {
  id: string;
  name?: string;
  type?: string;
}

export interface Relation {
  id?: string;
  from: string;
  to: string;
  type?: string;
  label?: string;
  line: number;
}

/** Одно упоминание элемента в связи: чекер сравнивает их между собой. */
export interface Mention extends Element {
  line: number;
}

export interface Block {
  id: string;
  /** id указан в заголовке: схема глобальная, иначе принадлежит файлу. */
  explicit: boolean;
  file: string;
  line: number;
  elements: Element[];
  relations: Relation[];
  mentions: Mention[];
  /** Строки, которые не удалось разобрать: они пропущены, остальной блок цел. */
  errors: ParseError[];
}

export class ParseError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/** id связи по концепту: явный `[id]` или `from>type>to`. */
export const relationId = (r: Relation) => r.id ?? [r.from, r.type, r.to].filter(Boolean).join(">");

/** Файл стиля новых стрелок лежит среди файлов типов, поэтому имя занято. */
export const DEFAULT_LINK_TYPE = "default-link";

const ID = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;
const DIAGRAM_ID = new RegExp(`^${ID}$`);
const MENTION =String.raw`(${ID})(?:\s+"([^"]*)")?(?:\s+\[([^\]]+)\])?`;
const DECLARATION = new RegExp(`^${MENTION}$`);
const RELATION = new RegExp(
  String.raw`^(?:\[([^\]]+)\]\s+)?${MENTION}\s+-(?:([a-z]+)-)?>\s+${MENTION}(?:\s*:\s*(.+))?$`,
);

/** Тег `<!-- archtale:diagram [id] -->`: без id — схема этого файла. */
export interface DiagramTag {
  id?: string;
  line: number;
}

const TAG = /^<!--\s*archtale:diagram(?:\s+(\S+))?\s*-->$/;

export function parseDiagramTags(source: string): DiagramTag[] {
  const tags: DiagramTag[] = [];
  visit(unified().use(remarkParse).parse(source), "html", (node: Html) => {
    const m = TAG.exec(node.value.trim());
    if (m) tags.push({ id: m[1], line: node.position!.start.line });
  });
  return tags;
}

export function parseMarkdown(source: string, fileStem: string, file = ""): Block[] {
  const blocks: Block[] = [];
  visit(unified().use(remarkParse).parse(source), "code", (node: Code) => {
    if (node.lang !== "model") return;
    const line = node.position!.start.line;
    const { id, explicit, extra } = parseHeader(node.meta, fileStem);
    const body = parseBody(node.value, line);
    if (extra.length) {
      body.errors.unshift(new ParseError(line, `в заголовке блока лишнее: «${extra.join(" ")}», нужен только id схемы`));
    }
    if (explicit && !DIAGRAM_ID.test(id)) {
      body.errors.unshift(new ParseError(line, `id схемы «${id}» должен быть в kebab-case`));
    }
    blocks.push({ id, explicit, file, line, ...body });
  });
  return blocks;
}

/**
 * Собирает блоки в схемы: блоки с одним явным id — этапы одной схемы, из
 * любых файлов; блоки без id — схема своего файла.
 * Связь, повторённая в другом блоке, та же самая: остаётся первое упоминание.
 */
export function groupIntoDiagrams(blocks: Block[]): Block[] {
  const diagrams = new Map<string, Block>();
  for (const block of blocks) {
    // Блок без связей — только объявления: идут в общий граф, схему не образуют.
    if (!block.relations.length) continue;
    const key = block.explicit ? `id:${block.id}` : `file:${block.file}`;
    const diagram = diagrams.get(key);
    if (!diagram) {
      diagrams.set(key, { ...block, elements: block.elements.map((e) => ({ ...e })) });
      continue;
    }
    for (const element of block.elements) {
      const known = diagram.elements.find((e) => e.id === element.id);
      if (known) {
        known.name ??= element.name;
        known.type ??= element.type;
      } else {
        diagram.elements.push({ ...element });
      }
    }
    const seen = new Set(diagram.relations.map(relationId));
    diagram.relations = [
      ...diagram.relations,
      ...block.relations.filter((r) => !seen.has(relationId(r))),
    ];
    diagram.mentions = [...diagram.mentions, ...block.mentions];
    diagram.errors = [...diagram.errors, ...block.errors];
  }
  // Элемент един на всю документацию: имя и тип могут быть заданы в любом блоке.
  const graph = new Map<string, Element>();
  for (const element of blocks.flatMap((b) => b.elements)) {
    const known = graph.get(element.id) ?? { id: element.id };
    known.name ??= element.name;
    known.type ??= element.type;
    graph.set(element.id, known);
  }
  for (const diagram of diagrams.values()) {
    for (const element of diagram.elements) {
      element.name ??= graph.get(element.id)?.name;
      element.type ??= graph.get(element.id)?.type;
    }
  }
  return [...diagrams.values()];
}

function parseHeader(meta: string | null | undefined, fileStem: string) {
  const [id, ...extra] = meta?.trim().split(/\s+/).filter(Boolean) ?? [];
  return { id: id ?? fileStem, explicit: id !== undefined, extra };
}

const LOOSE_MENTION = String.raw`(\S+)(?:\s+"[^"]*")?(?:\s+\[[^\]]+\])?`;
const LOOSE_LINE = new RegExp(
  String.raw`^(?:\[[^\]]+\]\s+)?${LOOSE_MENTION}(?:\s+-(?:\S*-)?>\s+${LOOSE_MENTION}(?:\s*:.*)?)?$`,
);

/** Причина ошибки разбора: неверный id, если строка похожа на модель, иначе ожидаемый формат. */
function explainLine(text: string): string {
  const ids = LOOSE_LINE.exec(text)?.slice(1).filter(Boolean) ?? [];
  // Стрелка внутри токена — это пропущенные пробелы, а не плохой id.
  const bad = ids.filter((id) => !DIAGRAM_ID.test(id) && !id.includes("->"));
  if (bad.length) {
    const names = bad.map((id) => `«${id}»`).join(", ");
    return `id ${names} должен быть в kebab-case: строчная латиница, цифры и дефисы, например order-flow`;
  }
  return 'ожидается `id "Имя" [тип]` или `a -тип-> b : подпись`, стрелка отделяется пробелами, тип связи — строчная латиница';
}

function parseBody(body: string, blockLine: number) {
  const elements = new Map<string, Element>();
  const relations: Relation[] = [];
  const mentions: Mention[] = [];
  const errors: ParseError[] = [];

  const mention = (line: number, id: string, name?: string, type?: string) => {
    const element = elements.get(id) ?? { id };
    element.name ??= name;
    element.type ??= type;
    elements.set(id, element);
    mentions.push({ id, name, type, line });
  };

  body.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    if (!text || text.startsWith("#")) return;
    const line = blockLine + i + 1;
    // Тип становится именем файла в папке типов.
    const checkType = (type?: string) => {
      if (type && !DIAGRAM_ID.test(type)) {
        errors.push(new ParseError(line, `тип «${type}» должен быть в kebab-case`));
      }
      if (type === DEFAULT_LINK_TYPE) {
        errors.push(new ParseError(line, `тип «${type}» зарезервирован для стиля стрелок`));
      }
    };
    const declaration = DECLARATION.exec(text);
    if (declaration) {
      const [, id, name, type] = declaration;
      checkType(type);
      mention(line, id, name, type);
      return;
    }
    const m = RELATION.exec(text);
    if (!m) {
      errors.push(new ParseError(line, `не разобрать «${text}»: ${explainLine(text)}`));
      return;
    }
    const [, relId, from, fromName, fromType, relType, to, toName, toType, label] = m;
    checkType(fromType);
    checkType(toType);
    mention(line, from, fromName, fromType);
    mention(line, to, toName, toType);
    relations.push({ id: relId, from, to, type: relType, label: label?.trim(), line });
  });

  return { elements: [...elements.values()], relations, mentions, errors };
}
