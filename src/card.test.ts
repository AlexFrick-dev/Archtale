import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD, CARD_FILE } from "./card.js";
import { parseDiagramTags, parseMarkdown } from "./parse.js";

test("примеры в карточке не становятся блоками и тегами", () => {
  assert.deepEqual(parseMarkdown(CARD, "ARCHTALE", CARD_FILE), []);
  assert.deepEqual(parseDiagramTags(CARD), []);
});
