import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { mergeDrawioSvg, newFigureSvg, readFigure } from "./drawio.js";
import { parseMarkdown } from "./parse.js";

const block = (body: string) =>
  parseMarkdown("```model b\n" + body + "\n```\n", "file")[0];

const decode = (svg: string) =>
  /\scontent="([^"]*)"/
    .exec(svg)![1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const escape = (xml: string) =>
  xml.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const file = (cells: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" content="${escape(
    `<mxfile><diagram id="b" name="b"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`,
  )}"><rect/></svg>`;

const anchor = (id: string, x: number) =>
  `<object label="" id="${id}" model-id="${id}" archtale="figure"><mxCell style="group;" vertex="1" parent="1"><mxGeometry x="${x}" y="7" width="140" height="60" as="geometry"/></mxCell></object>`;

/** Составная фигура: круг со смещением 10,20 и подпись. */
const composite = readFigure(
  file(
    `<mxCell id="round" value="" style="ellipse;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="100" as="geometry"/></mxCell>` +
      `<mxCell id="text" value="%caption% / %type% / %id%" style="text;" vertex="1" parent="1"><mxGeometry x="10" y="120" width="100" height="20" as="geometry"/></mxCell>`,
  ),
);

test("новая диаграмма: якорь с id модели, фигура внутри, связь", () => {
  const result = mergeDrawioSvg(block('a "А" -> b "Б": связь & <подпись>'));
  const xml = decode(result.svg);
  assert.match(xml, /id="a" model-id="a"/);
  assert.match(xml, /<mxCell style="group;"/);
  assert.match(xml, /id="a\/shape" value="А"[^>]*parent="a"/);
  assert.match(xml, /id="a&gt;b"/);
  assert.match(xml, /source="a"/);
  assert.match(xml, /label="связь &amp; &lt;подпись&gt;"/);
  assert.deepEqual(result.needsLayout, []);
});

test("фигура типа: свойства подставлены, координаты от угла, размер как у рисунка", () => {
  const figures = new Map([["person", composite]]);
  const xml = decode(mergeDrawioSvg(block('a "Имя" [person] -> b'), undefined, { figures }).svg);
  assert.match(xml, /id="a\/round"[^>]*><mxGeometry x="0" y="0" width="100" height="100"/);
  assert.match(xml, /value="Имя \/ person \/ a"/);
  assert.match(xml, /id="a\/text"[^>]*parent="a"[^>]*><mxGeometry x="0" y="100"/);
  assert.match(xml, /figure-size="100x120"/);
  // b без типа и без default в наборе — встроенная фигура.
  assert.match(xml, /id="b\/shape" value="b"/);
});

test("элемент без типа берёт default из набора", () => {
  const figures = new Map([["default", composite]]);
  const xml = decode(mergeDrawioSvg(block("a -> b"), undefined, { figures }).svg);
  assert.match(xml, /id="a\/round"/);
});

test("существующий якорь: положение остаётся, подпись из модели, файл сохраняет картинку", () => {
  const { svg } = mergeDrawioSvg(block('a "Новое" -> b'), file(anchor("a", 500) + anchor("b", 900)));
  const xml = decode(svg);
  assert.match(xml, /value="Новое"/);
  assert.match(xml, /x="500" y="7"/);
  assert.match(svg, /<rect\/>/);
});

test("смена фигуры типа доходит до схемы: содержимое пересоздаётся, положение остаётся", () => {
  const first = mergeDrawioSvg(block("a -> b")).svg;
  const moved = first.replace(/(id=&quot;a&quot;[\s\S]*?x=&quot;)0/, "$1500");
  assert.notEqual(moved, first);
  const figures = new Map([["default", composite]]);
  const xml = decode(mergeDrawioSvg(block("a -> b"), moved, { figures }).svg);
  assert.doesNotMatch(xml, /a\/shape/);
  assert.match(xml, /id="a\/round"/);
  assert.match(xml, /x="500"/);
  assert.match(xml, /<mxGeometry x="500" y="0" width="100" height="120"/);
});

test("растянутый руками якорь сохраняет размер, фигура масштабируется", () => {
  const first = mergeDrawioSvg(block("a -> b"), undefined, { figures: new Map([["default", composite]]) }).svg;
  const stretched = first.replace(/width=&quot;100&quot; height=&quot;120&quot;/, "width=&quot;200&quot; height=&quot;240&quot;");
  assert.notEqual(stretched, first);
  const xml = decode(mergeDrawioSvg(block("a -> b"), stretched, { figures: new Map([["default", composite]]) }).svg);
  assert.match(xml, /width="200" height="240"/);
  assert.match(xml, /id="a\/round"[^>]*><mxGeometry x="0" y="0" width="200" height="200"/);
});

test("ручная добавка в контейнере с чужим id остаётся при пересоздании", () => {
  const manual = `<mxCell id="note" value="заметка" vertex="1" parent="a"><mxGeometry as="geometry"/></mxCell>`;
  const xml = decode(mergeDrawioSvg(block("a -> b"), file(anchor("a", 0) + manual + anchor("b", 300))).svg);
  assert.match(xml, /value="заметка"/);
  assert.match(xml, /id="a\/shape"/);
});

test("новый элемент встаёт рядом с соседом и попадает в отчёт", () => {
  const result = mergeDrawioSvg(block("a -> c"), file(anchor("a", 500)));
  assert.deepEqual(result.needsLayout, ["c"]);
  assert.match(decode(result.svg), /x="760" y="7"/);
});

test("удалённый из модели элемент уходит со связями и содержимым", () => {
  const edge = `<object label="" id="a&gt;b" model-id="a&gt;b"><mxCell edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell></object>`;
  const inside = `<mxCell id="b/shape" vertex="1" parent="b"><mxGeometry as="geometry"/></mxCell>`;
  const result = mergeDrawioSvg(block("a -> z"), file(anchor("a", 0) + anchor("b", 300) + edge + inside));
  const xml = decode(result.svg);
  assert.deepEqual(result.removed.sort(), ["a>b", "b"]);
  assert.doesNotMatch(xml, /model-id="b"/);
  assert.doesNotMatch(xml, /b\/shape/);
});

test("ручные ячейки и копии не трогаются, ручная стрелка отвязывается", () => {
  const manual = `<mxCell id="manual" value="заметка" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>`;
  const copy = `<object label="копия" id="rnd" model-id="a"><mxCell vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell></object>`;
  const arrow = `<mxCell id="arrow" edge="1" parent="1" source="manual" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>`;
  const xml = decode(
    mergeDrawioSvg(block("a -> c"), file(anchor("a", 0) + anchor("b", 300) + manual + copy + arrow)).svg,
  );
  assert.match(xml, /value="заметка"/);
  assert.match(xml, /label="копия"/);
  assert.match(xml, /id="arrow"/);
  assert.match(xml, /source="manual"/);
  assert.doesNotMatch(xml, /target="b"/);
});

test("фигура с id из Edit Data остаётся как есть и со второго запуска", () => {
  const drawn = `<mxCell id="a" value="старое" style="ellipse;" vertex="1" parent="1"><mxGeometry x="42" width="10" height="10" as="geometry"/></mxCell>`;
  const first = mergeDrawioSvg(block('a "Имя" -> b'), file(drawn)).svg;
  const xml = decode(mergeDrawioSvg(block('a "Имя" -> b'), first).svg);
  assert.match(xml, /label="Имя" id="a" model-id="a" archtale="custom"/);
  assert.match(xml, /style="ellipse;"/);
  assert.match(xml, /x="42"/);
  assert.doesNotMatch(xml, /a\/shape/);
});

test("ячейка старого формата переводится на якорь с сохранением положения", () => {
  const old = `<object label="Сайт" id="a" model-id="a" tpl-style="x;"><mxCell style="rounded=1;" vertex="1" parent="1"><mxGeometry x="260" width="140" height="60" as="geometry"/></mxCell></object>`;
  const xml = decode(mergeDrawioSvg(block('a "Сайт" -> b'), file(old)).svg);
  assert.match(xml, /<mxCell style="group;"/);
  assert.doesNotMatch(xml, /tpl-style/);
  assert.match(xml, /x="260"/);
  assert.match(xml, /id="a\/shape" value="Сайт"/);
});

test("сжатая страница читается, результат несжатый", () => {
  const model = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${anchor("a", 500)}</root></mxGraphModel>`;
  const packed = deflateRawSync(encodeURIComponent(model)).toString("base64");
  const svg = `<svg content="${escape(`<mxfile><diagram id="b" name="b">${packed}</diagram></mxfile>`)}"></svg>`;
  const xml = decode(mergeDrawioSvg(block('a "Имя" -> b'), svg).svg);
  assert.match(xml, /x="500"/);
  assert.match(xml, /value="Имя"/);
});

test("файл нового типа: одна фигура с %caption%", () => {
  const figure = readFigure(newFigureSvg("person"));
  assert.equal(figure.cells.length, 1);
  assert.deepEqual([figure.width, figure.height], [140, 60]);
  assert.match(decode(newFigureSvg("person")), /value="%caption%"/);
});

test("пустой файл типа — ошибка", () => {
  assert.throws(() => readFigure(file("")), /нет ни одной фигуры/);
});

test("фон по умолчанию не задаётся, ручной сохраняется", () => {
  assert.doesNotMatch(decode(mergeDrawioSvg(block("a -> b")).svg), /background=/);
  const manual = `<svg content="${escape(
    `<mxfile><diagram id="b" name="b"><mxGraphModel background="#ffeeaa"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`,
  )}"></svg>`;
  assert.match(decode(mergeDrawioSvg(block("a -> b"), manual).svg), /background="#ffeeaa"/);
});

test("две одинаковые связи без [id] — ошибка", () => {
  assert.throws(() => mergeDrawioSvg(block("a -> b: раз\na -> b: два")), /задайте связи \[id\]/);
});
