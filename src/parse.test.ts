import assert from "node:assert/strict";
import { test } from "node:test";
import { groupIntoDiagrams, parseDiagramTags, parseMarkdown } from "./parse.js";

const fence = (header: string, body: string) => "```" + header + "\n" + body + "\n```\n\nтекст\n\n";
const diagrams = (md: string) => groupIntoDiagrams(parseMarkdown(md, "file"));

test("блоки с одним id собираются в одну схему", () => {
  const result = diagrams(fence("model s", 'a "А" -> b') + fence("model s", 'b "Б" -> c: дальше'));
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].elements.map((e) => [e.id, e.name]), [
    ["a", "А"],
    ["b", "Б"],
    ["c", undefined],
  ]);
  assert.equal(result[0].relations.length, 2);
});

test("блоки без id — одна схема с именем файла", () => {
  const result = diagrams(fence("model", "a -> b") + fence("model", "b -> c"));
  assert.deepEqual(result.map((d) => d.id), ["file"]);
});

test("разные id — разные схемы", () => {
  const result = diagrams(fence("model s1", "a -> b") + fence("model s2", "b -> c"));
  assert.deepEqual(result.map((d) => d.id), ["s1", "s2"]);
});

test("связь, повторённая в другом блоке, не дублируется", () => {
  const result = diagrams(fence("model s", "a -> b: раз") + fence("model s", "a -> b: раз\nb -> c"));
  assert.equal(result[0].relations.length, 2);
});

test("явный id собирает блоки из разных файлов, блоки без id — нет", () => {
  const one = parseMarkdown(fence("model s", "a -> b") + fence("model", "x -> y"), "same", "one/same.md");
  const two = parseMarkdown(fence("model s", "b -> c") + fence("model", "p -> q"), "same", "two/same.md");
  const result = groupIntoDiagrams([...one, ...two]);
  assert.deepEqual(result.map((d) => [d.id, d.file, d.relations.length]), [
    ["s", "one/same.md", 2],
    ["same", "one/same.md", 1],
    ["same", "two/same.md", 1],
  ]);
});

test("имя и тип берутся из всей документации", () => {
  const one = parseMarkdown(fence("model", 'a "А" [person] -> b'), "one", "one.md");
  const two = parseMarkdown(fence("model", "a -> c"), "two", "two.md");
  const [, second] = groupIntoDiagrams([...one, ...two]);
  assert.deepEqual(second.elements.find((e) => e.id === "a"), { id: "a", name: "А", type: "person" });
});

test("теги схем: с id и без, в коде не считаются", () => {
  const md = "<!-- archtale:diagram -->\n\nтекст\n\n<!-- archtale:diagram order-flow -->\n\n```\n<!-- archtale:diagram x -->\n```\n\n<!-- обычный -->\n";
  assert.deepEqual(parseDiagramTags(md), [
    { id: undefined, line: 1 },
    { id: "order-flow", line: 5 },
  ]);
});

test("id схемы проверяется на kebab-case, имя файла без id — нет", () => {
  for (const header of ["model Box_Flow", "model BoxFlow"]) {
    const [block] = parseMarkdown(fence(header, "a -> b"), "file");
    assert.match(block.errors[0].message, /kebab-case/);
    assert.equal(block.errors[0].line, 1);
  }
  assert.deepEqual(parseMarkdown(fence("model order-flow-2", "a -> b"), "file")[0].errors, []);
  assert.deepEqual(parseMarkdown(fence("model", "a -> b"), "Мой файл")[0].errors, []);
});

test("блок объявлений даёт имя и тип, но не образует схему и не выходит на неё", () => {
  const catalog = parseMarkdown(fence("model", 'm "Банк" [app]\nunused "Лишний" [app]'), "catalog", "catalog.md");
  assert.deepEqual(catalog[0].errors, []);
  const story = parseMarkdown(fence("model", "a -> m"), "story", "story.md");
  const result = groupIntoDiagrams([...catalog, ...story]);
  assert.deepEqual(result.map((d) => d.id), ["story"]);
  assert.deepEqual(result[0].elements.map((e) => e.id), ["a", "m"]);
  assert.deepEqual(result[0].elements[1], { id: "m", name: "Банк", type: "app" });
});

test("объявление в блоке со связями ставит элемент на схему", () => {
  const [diagram] = diagrams(fence("model", 'alone "Один" [app]\na -> b'));
  assert.deepEqual(diagram.elements.map((e) => e.id), ["alone", "a", "b"]);
  assert.equal(diagram.relations.length, 1);
});

test("тип проверяется на kebab-case", () => {
  const [block] = parseMarkdown(fence("model", "a [Bad/Type] -> b [good-type]"), "file");
  assert.equal(block.errors.length, 1);
  assert.match(block.errors[0].message, /Bad\/Type/);
});

test("тип default-link зарезервирован", () => {
  const [block] = parseMarkdown(fence("model", "a [default-link] -> b"), "file");
  assert.match(block.errors[0].message, /зарезервирован/);
});

test("ошибка разбора называет неверный id", () => {
  const message = (line: string) => parseMarkdown(fence("model", line), "file")[0].errors[0].message;
  assert.match(message('Gatekeeper "Привратник" [gk]'), /id «Gatekeeper» должен быть в kebab-case/);
  assert.match(message("Foo -> order_flow : текст"), /id «Foo», «order_flow» должен быть/);
});

test("ошибка разбора без неверного id показывает формат", () => {
  const message = (line: string) => parseMarkdown(fence("model", line), "file")[0].errors[0].message;
  assert.match(message("a->b"), /ожидается/);
  assert.match(message("a -Calls-> b"), /ожидается/);
  assert.match(message("просто какой-то текст"), /ожидается/);
});

test("лишнее в заголовке — ошибка: старый `model flow s` не становится схемой flow молча", () => {
  const [block] = parseMarkdown(fence("model flow s", "a -> b"), "file");
  assert.match(block.errors[0].message, /лишнее: «s»/);
  assert.equal(block.errors[0].line, 1);
});
