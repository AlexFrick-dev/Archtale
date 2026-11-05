import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "./check.js";
import { parseMarkdown } from "./parse.js";

const source = (file: string, body: string) => ({
  file,
  blocks: parseMarkdown("текст\n\n```model b\n" + body + "\n```\n", "f"),
});

const messages = (...files: ReturnType<typeof source>[]) => check(files).map((i) => i.message);

test("согласованная модель без замечаний", () => {
  assert.deepEqual(
    messages(source("a.md", 'x "Икс" [app] -> y "Игрек" [app]: связь'), source("b.md", "x -> y: связь")),
    [],
  );
});

test("разные имена: обе ссылки с файлом и строкой", () => {
  const issues = check([
    source("a.md", 'x "Икс" -> y "Игрек"\nx -> y'),
    source("b.md", 'x "Другое" -> y'),
  ]);
  const issue = issues.find((i) => i.message === "разные имена у «x»")!;
  assert.deepEqual(
    issue.locations.map((l) => [l.file, l.line, l.detail]),
    [
      ["a.md", 4, "Икс"],
      ["b.md", 4, "Другое"],
    ],
  );
});

test("разные типы", () => {
  assert.ok(
    messages(source("a.md", 'x "И" [component] -> y "Й"\nx [device] -> y')).includes("разные типы у «x»"),
  );
});

test("элемент без имени, если имени нет ни в одном упоминании", () => {
  const result = messages(source("a.md", 'x -> y "Игрек"\nx -> y'), source("b.md", 'y -> x'));
  assert.ok(result.includes("элемент без имени «x»"));
  assert.ok(!result.includes("элемент без имени «y»"));
});

test("упомянут один раз", () => {
  const result = messages(source("a.md", 'x "И" -> y "Й"\nx -> z "З"'));
  assert.ok(result.includes("упомянут один раз «y»"));
  assert.ok(!result.includes("упомянут один раз «x»"));
});

test("одна связь с разными подписями; разные типы связи — разные связи", () => {
  assert.ok(
    messages(source("a.md", "x -> y: раз"), source("b.md", "x -> y: два")).includes(
      "разные подписи у связи «x>y»",
    ),
  );
  assert.ok(
    !messages(source("a.md", "x -flows-> y: раз"), source("b.md", "x -serves-> y: два")).some((m) =>
      m.startsWith("разные подписи"),
    ),
  );
});

test("похожие id: опечатка и перестановка, разные слова не считаются", () => {
  assert.ok(messages(source("a.md", "agro -> argo")).includes("похожие id «agro» и «argo»"));
  assert.ok(
    messages(source("a.md", "order-service -> order-servce")).includes(
      "похожие id «order-service» и «order-servce»",
    ),
  );
  assert.ok(!messages(source("a.md", "site -> bank")).some((m) => m.startsWith("похожие")));
});

test("ошибка синтаксиса: замечание со строкой, остальной блок проверяется", () => {
  const issues = check([source("a.md", 'xx "И" -> yy "Й"\nэто не связь\nxx "Другое" -> yy')]);
  const error = issues.find((i) => i.message.startsWith("не разобрать"))!;
  assert.deepEqual(error.locations, [{ file: "a.md", line: 5 }]);
  assert.ok(issues.some((i) => i.message === "разные имена у «xx»"));
});

test("тег на неизвестную схему и тег без схемы файла", () => {
  const result = check([
    { ...source("a.md", "x -> y"), tags: [{ id: "nope", line: 1 }, { id: "b", line: 2 }, { line: 3 }] },
  ]).map((i) => i.message);
  assert.ok(result.includes("тег ссылается на неизвестную схему «nope»"));
  assert.ok(!result.includes("тег ссылается на неизвестную схему «b»"));
  assert.ok(result.includes("тег без id, но в файле нет схемы без id"));
});

test("на разных схемах подписи одной связи могут отличаться", () => {
  const blocks = (file: string, md: string) => ({ file, blocks: parseMarkdown(md, "f", file) });
  const twoDiagrams = check([
    blocks("a.md", "```model one\nxx -> yy: кратко\n```\n\n```model\nxx -> yy: подробно\n```\n"),
  ]).map((i) => i.message);
  assert.ok(!twoDiagrams.some((m) => m.startsWith("разные подписи")));
  const oneDiagram = check([
    blocks("a.md", "```model one\nxx -> yy: раз\n```\n"),
    blocks("b.md", "```model one\nxx -> yy: два\n```\n"),
  ]).map((i) => i.message);
  assert.ok(oneDiagram.includes("разные подписи у связи «xx>yy»"));
});

test("элемент без типа и похожие типы", () => {
  const result = messages(source("a.md", 'xx [person] -> yy\nzz [persn] -> xx\nxx -> zz'));
  assert.ok(result.includes("элемент без типа «yy»"));
  assert.ok(!result.includes("элемент без типа «xx»"));
  assert.ok(result.includes("похожие типы «person» и «persn»"));
});

test("объявление считается упоминанием, неиспользуемое видно", () => {
  const result = messages(
    source("catalog.md", 'used "И" [app]\nunused "Л" [app]'),
    source("a.md", 'used -> other "Д" [app]\nused -> other'),
  );
  assert.ok(result.includes("упомянут один раз «unused»"));
  assert.ok(!result.includes("упомянут один раз «used»"));
  assert.ok(!result.includes("элемент без типа «used»"));
});

test("короткие id не считаются похожими", () => {
  assert.ok(!messages(source("a.md", "x -> y")).some((m) => m.startsWith("похожие")));
});
