import { inflateRawSync } from "node:zlib";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { DEFAULT_LINK_TYPE, relationId, type Block, type Element } from "./parse.js";

const WIDTH = 140;
const HEIGHT = 60;
const GAP = 120;

const NODE_STYLE = "rounded=1;whiteSpace=wrap;html=1;";
const EDGE_STYLE = "rounded=0;html=1;endArrow=block;";
const ANCHOR_STYLE = "group;";

export const DEFAULT_TYPE = "default";

const ATTRS = ":@";
const CONTENT = /\scontent="([^"]*)"/;

// Дерево fast-xml-parser в режиме preserveOrder: { tag: children, ":@": attrs }.
type XmlNode = Record<string, any>;

const xmlOptions = { ignoreAttributes: false, attributeNamePrefix: "", preserveOrder: true };
const parser = new XMLParser({ ...xmlOptions, parseTagValue: false, parseAttributeValue: false });
const builder = new XMLBuilder({ ...xmlOptions, suppressEmptyNode: true, suppressBooleanAttributes: false });

export interface MergeResult {
  svg: string;
  needsLayout: string[];
  removed: string[];
}

/** Содержимое файла типа: всё, что нарисовано, и его габариты. */
export interface Figure {
  cells: XmlNode[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MergeOptions {
  figures?: Map<string, Figure>;
  /** Стиль новых стрелок; уже нарисованные его не получают. */
  edgeStyle?: string;
}

const escapeAttr = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const unescapeAttr = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const tagOf = (node: XmlNode) => Object.keys(node).find((key) => key !== ATTRS)!;
const child = (node: XmlNode, tag: string): XmlNode =>
  node[tagOf(node)].find((c: XmlNode) => tagOf(c) === tag);
const cellOf = (node: XmlNode): XmlNode => (tagOf(node) === "mxCell" ? node : child(node, "mxCell"));
const cellAttrs = (node: XmlNode): Record<string, string> => cellOf(node)[ATTRS] ?? {};
const geometryAttrs = (cell: XmlNode): Record<string, string> | undefined =>
  child(cellOf(cell), "mxGeometry")?.[ATTRS];

/** Обёртка `object` нужна, чтобы хранить свойства: у голого mxCell их нет. */
function asObject(node: XmlNode): void {
  if (tagOf(node) !== "mxCell") return;
  const { id, value, ...rest } = node[ATTRS];
  node.object = [{ mxCell: node.mxCell, [ATTRS]: rest }];
  delete node.mxCell;
  node[ATTRS] = { label: value ?? "", id };
}

function makeCell(id: string, cell: Record<string, string>, geometry: Record<string, string>): XmlNode {
  return {
    object: [{ mxCell: [{ mxGeometry: [], [ATTRS]: { ...geometry, as: "geometry" } }], [ATTRS]: cell }],
    [ATTRS]: { label: "", id, "model-id": id },
  };
}

/** Новый файл диаграммы с первой страницей без ячеек. */
function emptyFile(id: string, cells: XmlNode[] = []): XmlNode[] {
  const root = [
    { mxCell: [], [ATTRS]: { id: "0" } },
    { mxCell: [], [ATTRS]: { id: "1", parent: "0" } },
    ...cells,
  ];
  return [
    {
      mxfile: [
        {
          diagram: [{ mxGraphModel: [{ root }] }],
          [ATTRS]: { id, name: id },
        },
      ],
    },
  ];
}

function readFile(svg: string): XmlNode[] {
  const match = CONTENT.exec(svg);
  if (!match) throw new Error("в файле нет атрибута content с диаграммой");
  const tree: XmlNode[] = parser.parse(unescapeAttr(match[1]));
  const page = tree.find((n) => tagOf(n) === "mxfile")?.mxfile.find((n: XmlNode) => tagOf(n) === "diagram");
  if (!page) throw new Error("в файле нет страницы диаграммы");
  const text = page.diagram.find((n: XmlNode) => tagOf(n) === "#text");
  if (text) {
    // draw.io может сохранить страницу сжатой. Записываем её всегда несжатой.
    const inflated = inflateRawSync(Buffer.from(text["#text"].trim(), "base64")).toString();
    page.diagram = parser.parse(decodeURIComponent(inflated));
  }
  return tree;
}

const pageRoot = (tree: XmlNode[]): XmlNode => {
  const page = tree.find((n) => tagOf(n) === "mxfile")!.mxfile.find((n: XmlNode) => tagOf(n) === "diagram");
  const graph = page.diagram.find((n: XmlNode) => tagOf(n) === "mxGraphModel");
  return graph.mxGraphModel.find((n: XmlNode) => tagOf(n) === "root");
};

const serialize = (tree: XmlNode[], existing?: string) => {
  const content = escapeAttr(builder.build(tree));
  return existing
    ? existing.replace(CONTENT, () => ` content="${content}"`)
    : `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" content="${content}"></svg>\n`;
};

/** Ячейка и все её потомки. */
function withDescendants(id: string, cells: XmlNode[]): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const cell of cells) {
      if (cellAttrs(cell).parent && ids.has(cellAttrs(cell).parent) && !ids.has(cell[ATTRS].id)) {
        ids.add(cell[ATTRS].id);
        grew = true;
      }
    }
  }
  return ids;
}

function geometryOf(cell: XmlNode) {
  const g = geometryAttrs(cell) ?? {};
  return {
    x: Number(g.x ?? 0),
    y: Number(g.y ?? 0),
    width: Number(g.width ?? WIDTH),
    height: Number(g.height ?? HEIGHT),
  };
}

function overlapsAny(cells: XmlNode[], x: number, y: number, size: { width: number; height: number }) {
  return cells.some((c) => {
    const g = geometryOf(c);
    return x < g.x + g.width && g.x < x + size.width && y < g.y + g.height && g.y < y + size.height;
  });
}

/** Простое размещение: правее источника или левее цели, при занятом месте — ниже. */
function placeNew(element: Element, block: Block, cells: XmlNode[], size: { width: number; height: number }) {
  const topLevel = cells.filter((c) => cellAttrs(c).parent === "1" && cellAttrs(c).vertex === "1");
  const find = (id: string) => topLevel.find((c) => c[ATTRS].id === id);
  const source = block.relations.map((r) => (r.to === element.id ? find(r.from) : undefined)).find(Boolean);
  const target = block.relations.map((r) => (r.from === element.id ? find(r.to) : undefined)).find(Boolean);

  let x: number;
  let y: number;
  if (source) {
    const g = geometryOf(source);
    x = g.x + g.width + GAP;
    y = g.y;
  } else if (target) {
    const g = geometryOf(target);
    x = g.x - size.width - GAP;
    y = g.y;
  } else {
    x = topLevel.reduce((max, c) => Math.max(max, geometryOf(c).x + geometryOf(c).width + GAP), 0);
    y = 0;
  }
  while (overlapsAny(topLevel, x, y, size)) y += size.height + GAP;
  return { x, y };
}

function assertUniqueIds(block: Block): void {
  const seen = new Set(block.elements.map((e) => e.id));
  for (const relation of block.relations) {
    const id = relationId(relation);
    if (seen.has(id)) throw new Error(`блок ${block.id}: повторяется id «${id}», задайте связи [id]`);
    seen.add(id);
  }
}

/** Файл нового типа: простая фигура с подписью, дальше её рисует человек. */
export function newFigureSvg(type: string): string {
  const shape = {
    mxCell: [
      {
        mxGeometry: [],
        [ATTRS]: { x: "0", y: "0", width: String(WIDTH), height: String(HEIGHT), as: "geometry" },
      },
    ],
    [ATTRS]: { id: "shape", value: "%caption%", style: NODE_STYLE, vertex: "1", parent: "1" },
  };
  return serialize(emptyFile(type, [shape]));
}

/** Файл стиля стрелок: одна стрелка без концов, дальше её настраивает человек. */
export function newLinkSvg(): string {
  const point = (x: number, as: string) => ({ mxPoint: [], [ATTRS]: { x: String(x), y: "30", as } });
  const link = {
    mxCell: [
      {
        mxGeometry: [point(0, "sourcePoint"), point(WIDTH, "targetPoint")],
        [ATTRS]: { relative: "1", as: "geometry" },
      },
    ],
    // Подпись-образец: без неё в draw.io нечего настраивать. На схемы текст не переносится.
    [ATTRS]: { id: "link", value: "подпись", style: EDGE_STYLE, edge: "1", parent: "1" },
  };
  return serialize(emptyFile(DEFAULT_LINK_TYPE, [link]));
}

/** Берёт из файла только стиль: подпись и концы стрелки задаёт модель. */
export function readLinkStyle(svg: string): string {
  const root: XmlNode[] = pageRoot(readFile(svg)).root;
  const edges = root.filter((c) => cellAttrs(c).edge === "1");
  if (edges.length !== 1) throw new Error(`в файле стиля нужна ровно одна стрелка, найдено: ${edges.length}`);
  return cellAttrs(edges[0]).style ?? "";
}

/** Читает файл типа: все ячейки, кроме служебных и слоёв. Габариты — по фигурам верхнего уровня. */
export function readFigure(svg: string): Figure {
  const all: XmlNode[] = pageRoot(readFile(svg)).root;
  const cells = all.filter((c) => {
    const parent = cellAttrs(c).parent;
    return parent !== undefined && parent !== "0";
  });
  const ids = new Set(cells.map((c) => c[ATTRS].id));
  const top = cells
    .filter((c) => !ids.has(cellAttrs(c).parent) && cellAttrs(c).vertex === "1")
    .map(geometryOf);
  if (!top.length) throw new Error("в файле типа нет ни одной фигуры");
  const x = Math.min(...top.map((g) => g.x));
  const y = Math.min(...top.map((g) => g.y));
  return {
    cells,
    x,
    y,
    width: Math.max(...top.map((g) => g.x + g.width)) - x,
    height: Math.max(...top.map((g) => g.y + g.height)) - y,
  };
}

const round = (value: number) => String(Math.round(value * 100) / 100);

/** Копия фигуры внутрь якоря: свои id, координаты от угла якоря, подстановка свойств. */
function instantiate(figure: Figure, element: Element, width: number, height: number): XmlNode[] {
  const sx = width / figure.width;
  const sy = height / figure.height;
  const ids = new Set(figure.cells.map((c) => c[ATTRS].id as string));
  const newId = (id: string) => `${element.id}/${id}`;
  const values: Record<string, string> = {
    "%caption%": element.name ?? element.id,
    "%id%": element.id,
    "%type%": element.type ?? "",
  };
  const fill = (text: string) =>
    text.replace(/%caption%|%id%|%type%/g, (placeholder) => values[placeholder]);

  return figure.cells.map((source) => {
    const clone: XmlNode = structuredClone(source);
    const outer = clone[ATTRS];
    const inner = cellAttrs(clone);
    const top = !ids.has(inner.parent);

    outer.id = newId(outer.id);
    inner.parent = top ? element.id : newId(inner.parent);
    if (ids.has(inner.source)) inner.source = newId(inner.source);
    if (ids.has(inner.target)) inner.target = newId(inner.target);
    for (const attrs of [outer, inner]) {
      for (const key of ["value", "label"]) {
        if (typeof attrs[key] === "string") attrs[key] = fill(attrs[key]);
      }
    }

    const dx = top ? figure.x : 0;
    const dy = top ? figure.y : 0;
    const movePoints = (nodes: XmlNode[]) => {
      for (const node of nodes) {
        if (tagOf(node) === "mxPoint") {
          const point = node[ATTRS];
          if (point.x !== undefined) point.x = round((Number(point.x) - dx) * sx);
          if (point.y !== undefined) point.y = round((Number(point.y) - dy) * sy);
        } else if (Array.isArray(node[tagOf(node)])) {
          movePoints(node[tagOf(node)]);
        }
      }
    };
    const geometry = child(cellOf(clone), "mxGeometry");
    if (geometry) {
      const g = geometry[ATTRS] ?? {};
      // У относительной геометрии координаты — доли родителя, масштаб уже учтён.
      if (g.relative !== "1") {
        g.x = round((Number(g.x ?? 0) - dx) * sx);
        g.y = round((Number(g.y ?? 0) - dy) * sy);
        if (g.width !== undefined) g.width = round(Number(g.width) * sx);
        if (g.height !== undefined) g.height = round(Number(g.height) * sy);
      }
      movePoints(geometry.mxGeometry);
    }
    return clone;
  });
}

/**
 * Обновляет диаграмму по блоку модели. Элемент — невидимый контейнер-якорь с
 * копией фигуры своего типа: положение якоря хранится, содержимое пересоздаётся.
 * Модельная ячейка — та, у которой `model-id` равен id: копия в draw.io получает
 * новый id и становится ручной добавкой. Фигура, которой человек сам задал id
 * модели (`archtale="custom"`), остаётся как есть, обновляется только подпись.
 */
export function mergeDrawioSvg(block: Block, existing?: string, options: MergeOptions = {}): MergeResult {
  assertUniqueIds(block);
  const builtin = readFigure(newFigureSvg(DEFAULT_TYPE));
  const figureFor = (element: Element) =>
    options.figures?.get(element.type ?? DEFAULT_TYPE) ?? options.figures?.get(DEFAULT_TYPE) ?? builtin;

  const tree = existing ? readFile(existing) : emptyFile(block.id);
  const rootNode = pageRoot(tree);
  let cells: XmlNode[] = rootNode.root;

  const wanted = new Set([...block.elements.map((e) => e.id), ...block.relations.map(relationId)]);

  // Удаление: только модельные ячейки, вместе со всем, что внутри них.
  const removed = cells
    .filter((c) => c[ATTRS]?.["model-id"] === c[ATTRS]?.id && c[ATTRS]?.id && !wanted.has(c[ATTRS].id))
    .map((c) => c[ATTRS].id as string);
  const gone = new Set(removed.flatMap((id) => [...withDescendants(id, cells)]));
  cells = cells.filter((c) => !gone.has(c[ATTRS]?.id));

  // Ручная стрелка переживает удаление фигуры, но отвязывается от неё.
  for (const cell of cells) {
    const attrs = cellAttrs(cell);
    if (gone.has(attrs.source)) delete attrs.source;
    if (gone.has(attrs.target)) delete attrs.target;
  }

  const byId = (id: string) => cells.find((c) => c[ATTRS]?.id === id);
  const update = (cell: XmlNode, id: string, label: string) => {
    asObject(cell);
    cell[ATTRS].label = label;
    cell[ATTRS]["model-id"] = id;
  };

  const needsLayout: string[] = [];
  for (const element of block.elements) {
    const figure = figureFor(element);
    let anchor = byId(element.id);

    if (anchor && (anchor[ATTRS].archtale ?? (anchor[ATTRS]["model-id"] ? "figure" : "custom")) === "custom") {
      update(anchor, element.id, element.name ?? element.id);
      anchor[ATTRS].archtale = "custom";
      continue;
    }

    if (!anchor) {
      const size = { width: figure.width, height: figure.height };
      const { x, y } = placeNew(element, block, cells, size);
      anchor = makeCell(
        element.id,
        { style: ANCHOR_STYLE, vertex: "1", parent: "1" },
        { x: String(x), y: String(y), width: round(size.width), height: round(size.height) },
      );
      cells.push(anchor);
      if (existing) needsLayout.push(element.id);
    }

    // Размер берём из фигуры, пока якорь не растягивали руками. Положение не трогаем.
    const geometry = geometryAttrs(anchor)!;
    const stored = anchor[ATTRS]["figure-size"];
    const resized = stored !== undefined && stored !== `${geometry.width}x${geometry.height}`;
    if (!resized) {
      geometry.width = round(figure.width);
      geometry.height = round(figure.height);
      anchor[ATTRS]["figure-size"] = `${geometry.width}x${geometry.height}`;
    }

    update(anchor, element.id, "");
    anchor[ATTRS].archtale = "figure";
    delete anchor[ATTRS]["tpl-style"];
    cellAttrs(anchor).style = ANCHOR_STYLE;

    const prefix = `${element.id}/`;
    cells = cells.filter((c) => !String(c[ATTRS]?.id ?? "").startsWith(prefix));
    const content = instantiate(figure, element, Number(geometry.width), Number(geometry.height));
    cells.splice(cells.indexOf(anchor) + 1, 0, ...content);
  }

  for (const relation of block.relations) {
    const id = relationId(relation);
    let cell = byId(id);
    if (!cell) {
      cell = makeCell(id, { style: options.edgeStyle ?? EDGE_STYLE, edge: "1", parent: "1" }, { relative: "1" });
      cells.push(cell);
    }
    update(cell, id, relation.label ?? "");
    cellAttrs(cell).source = relation.from;
    cellAttrs(cell).target = relation.to;
  }

  rootNode.root = cells;
  return { svg: serialize(tree, existing), needsLayout, removed };
}
