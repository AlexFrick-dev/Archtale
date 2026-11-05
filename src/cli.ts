#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { check, type SourceFile } from "./check.js";
import { DEFAULT_TYPE, mergeDrawioSvg, newFigureSvg, readFigure, type Figure } from "./drawio.js";
import { groupIntoDiagrams, parseDiagramTags, parseMarkdown, type Block } from "./parse.js";
import { renderInPlace, resolveDrawio } from "./render.js";

async function findMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : findMarkdown(full);
      return entry.name.endsWith(".md") ? [full] : [];
    }),
  );
  return nested.flat();
}

interface LoadedFile extends SourceFile {
  source: string;
}

async function loadSources(dir: string): Promise<LoadedFile[]> {
  const files = (await findMarkdown(dir)).sort();
  return Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, "utf8");
      return {
        file,
        source,
        blocks: parseMarkdown(source, path.basename(file, ".md"), file),
        tags: parseDiagramTags(source),
      };
    }),
  );
}

/** Схема с id лежит в общей папке корня, схема файла — рядом с ним. */
function diagramPath(root: string, file: string, id?: string): string {
  return id
    ? path.join(root, "diagrams", `${id}.drawio.svg`)
    : path.join(path.dirname(file), "diagrams", `${path.basename(file, ".md")}.drawio.svg`);
}

const TYPES_DIR = "archtale-types";
const DRAWIO_SVG = ".drawio.svg";
const IMAGE =/^!\[[^\]]*\]\([^)]*\)\s*$/;

/** Поддерживает под каждым тегом строку с картинкой; остальной текст не меняется. */
function syncTags({ file, source, tags = [] }: LoadedFile, root: string, known: Set<string>): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  for (const { id, line } of [...tags].reverse()) {
    const target = diagramPath(root, file, id);
    if (!known.has(target)) continue;
    const link = path.relative(path.dirname(file), target).split(path.sep).join("/");
    const image = `![](${link})`;
    if (IMAGE.test(lines[line] ?? "")) lines[line] = image;
    // Без пустой строки картинка склеилась бы со следующим текстом в один абзац.
    else lines.splice(line, 0, ...(lines[line]?.trim() ? [image, ""] : [image]));
  }
  return lines.join(eol);
}

async function runCheck(dir: string, options: { strict?: boolean }) {
  const sources = await loadSources(dir);
  const issues = check(sources);

  for (const { message, locations } of issues) {
    console.log(message);
    for (const { file, line, detail } of locations) {
      console.log(`  ${file}:${line}${detail ? ` ${detail}` : ""}`);
    }
  }
  const elements = new Set(sources.flatMap((s) => s.blocks.flatMap((b) => b.elements.map((e) => e.id))));
  const blocks = sources.reduce((sum, s) => sum + s.blocks.length, 0);
  console.log(`блоков: ${blocks}, элементов: ${elements.size}, замечаний: ${issues.length}`);
  if (options.strict && issues.length) process.exitCode = 1;
}

const readIfExists = (file: string) =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

async function generate(dir: string, options: { drawio?: string; strict?: boolean }) {
  const drawio = resolveDrawio(options.drawio);
  const sources = await loadSources(dir);

  // Сначала разбор всего, запись потом: ошибка не должна оставлять документацию наполовину обновлённой.
  // Пропавшая строка к тому же удалила бы элемент со схемы вместе с ручной раскладкой.
  for (const { file, blocks } of sources) {
    const error = blocks.flatMap((b) => b.errors)[0];
    if (error) throw new Error(`${file}:${error.line}: ${error.message}`);
  }
  const diagrams = groupIntoDiagrams(sources.flatMap((s) => s.blocks));
  const targets = new Map<string, Block>();
  for (const block of diagrams) {
    const out = diagramPath(dir, block.file, block.explicit ? block.id : undefined);
    const other = targets.get(out);
    if (other) {
      throw new Error(`${block.file}:${block.line}: схема «${block.id}» занимает тот же файл, что и схема из ${other.file}:${other.line}`);
    }
    targets.set(out, block);
  }

  let pending = 0;

  // Файлы типов: новые создаются один раз, готовые принадлежат человеку и не перезаписываются.
  const typesDir = path.join(dir, TYPES_DIR);
  await mkdir(typesDir, { recursive: true });
  const types = new Set([
    DEFAULT_TYPE,
    ...diagrams.flatMap((d) => d.elements.flatMap((e) => e.type ?? [])),
  ]);
  const figures = new Map<string, Figure>();
  const added: string[] = [];
  for (const type of [...types].sort()) {
    const file = path.join(typesDir, `${type}${DRAWIO_SVG}`);
    let svg = await readIfExists(file);
    if (svg === undefined) {
      svg = newFigureSvg(type);
      await writeFile(file, svg);
      if (!(await renderInPlace(file, drawio))) pending++;
      if (type !== DEFAULT_TYPE) added.push(type);
    }
    try {
      figures.set(type, readFigure(svg));
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`);
    }
  }
  if (added.length) console.log(`новые типы: ${added.join(", ")} -> ${typesDir}`);
  const unused = (await readdir(typesDir))
    .filter((name) => name.endsWith(DRAWIO_SVG))
    .map((name) => name.slice(0, -DRAWIO_SVG.length))
    .filter((type) => !types.has(type));
  if (unused.length) console.log(`не используются типы: ${unused.join(", ")}`);

  for (const [out, block] of targets) {
    await mkdir(path.dirname(out), { recursive: true });
    const existing = await readIfExists(out);
    const { svg, needsLayout, removed } = mergeDrawioSvg(block, existing, { figures });
    await writeFile(out, svg);
    if (!(await renderInPlace(out, drawio))) pending++;
    console.log(`${block.file}:${block.line} -> ${out}`);
    if (needsLayout.length) console.log(`  требует раскладки: ${needsLayout.join(", ")}`);
    if (removed.length) console.log(`  удалено: ${removed.join(", ")}`);
  }

  const known = new Set(targets.keys());
  for (const loaded of sources) {
    const updated = syncTags(loaded, dir, known);
    if (updated !== loaded.source) {
      await writeFile(loaded.file, updated);
      console.log(`${loaded.file}: обновлены ссылки на схемы`);
    }
    // Вставка картинок сдвигает строки: номера берём из обновлённого текста.
    for (const tag of parseDiagramTags(updated)) {
      if (!known.has(diagramPath(dir, loaded.file, tag.id))) {
        console.warn(`${loaded.file}:${tag.line}: схема для тега не найдена`);
      }
    }
  }

  if (pending) {
    console.warn(`draw.io не найден: ${pending} схем ждут рендера`);
    if (options.strict) process.exitCode = 1;
  }
}

const program = new Command("archtale");
program
  .command("check")
  .argument("[dir]", "корень документации", ".")
  .description("показать расхождения в модели")
  .option("--strict", "ненулевой код выхода, если есть замечания")
  .action(runCheck);
program
  .command("generate")
  .argument("[dir]", "корень документации", ".")
  .description("сгенерировать диаграммы из блоков model")
  .option("--drawio <path>", "путь к draw.io desktop")
  .option("--strict", "ненулевой код выхода, если остались схемы без рендера")  .action(generate);

await program.parseAsync();
