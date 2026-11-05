import { relationId, type Block, type DiagramTag } from "./parse.js";

export interface SourceFile {
  file: string;
  blocks: Block[];
  tags?: DiagramTag[];
}

export interface Location {
  file: string;
  line: number;
  detail?: string;
}

export interface Issue {
  message: string;
  locations: Location[];
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** Расстояние редактирования, перестановка соседних букв считается за одну правку. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Сводит блоки в общий граф и показывает расхождения. Решение остаётся за человеком. */
export function check(sources: SourceFile[]): Issue[] {
  const issues: Issue[] = sources.flatMap(({ file, blocks }) =>
    blocks.flatMap((block) =>
      block.errors.map(({ message, line }) => ({ message, locations: [{ file, line }] })),
    ),
  );
  const mentions = sources.flatMap(({ file, blocks }) =>
    blocks.flatMap((block) => block.mentions.map((m) => ({ ...m, file }))),
  );
  const relations = sources.flatMap(({ file, blocks }) =>
    blocks.flatMap((block) =>
      block.relations.map((r) => ({
        ...r,
        file,
        relId: relationId(r),
        diagram: block.explicit ? `id:${block.id}` : `file:${file}`,
      })),
    ),
  );
  const elements = groupBy(mentions, (m) => m.id);

  const conflict = (what: string, id: string, values: { value?: string; file: string; line: number }[]) => {
    const given = values.filter((v) => v.value !== undefined);
    if (new Set(given.map((v) => v.value)).size > 1) {
      issues.push({
        message: `${what} «${id}»`,
        locations: given.map(({ file, line, value }) => ({ file, line, detail: value })),
      });
    }
  };

  for (const [id, group] of elements) {
    conflict("разные имена у", id, group.map((m) => ({ ...m, value: m.name })));
    conflict("разные типы у", id, group.map((m) => ({ ...m, value: m.type })));
    if (!group.some((m) => m.name)) {
      issues.push({ message: `элемент без имени «${id}»`, locations: [group[0]] });
    }
    if (!group.some((m) => m.type)) {
      issues.push({ message: `элемент без типа «${id}»`, locations: [group[0]] });
    }
    if (group.length === 1) {
      issues.push({ message: `упомянут один раз «${id}»`, locations: [group[0]] });
    }
  }

  // Подпись описывает связь в контексте истории: на разных схемах она может отличаться.
  for (const group of groupBy(relations, (r) => `${r.diagram}|${r.relId}`).values()) {
    conflict("разные подписи у связи", group[0].relId, group.map((r) => ({ ...r, value: r.label })));
  }

  const drawn = (b: Block) => b.relations.length > 0;
  const globalIds = new Set(sources.flatMap((s) => s.blocks.filter((b) => b.explicit && drawn(b)).map((b) => b.id)));
  for (const { file, blocks, tags = [] } of sources) {
    for (const { id, line } of tags) {
      if (id && !globalIds.has(id)) {
        issues.push({ message: `тег ссылается на неизвестную схему «${id}»`, locations: [{ file, line }] });
      }
      if (!id && !blocks.some((b) => !b.explicit && drawn(b))) {
        issues.push({ message: "тег без id, но в файле нет схемы без id", locations: [{ file, line }] });
      }
    }
  }

  const similar = <T extends { file: string; line: number }>(what: string, groups: Map<string, T[]>) => {
    const names = [...groups.keys()];
    names.forEach((a, i) => {
      for (const b of names.slice(i + 1)) {
        // В именах короче трёх букв одна правка — уже другое слово, в длинных допускаем две.
        const shortest = Math.min(a.length, b.length);
        const limit = shortest >= 8 ? 2 : shortest >= 3 ? 1 : 0;
        if (editDistance(a, b) <= limit) {
          const at = (name: string) => {
            const { file, line } = groups.get(name)![0];
            return { file, line, detail: name };
          };
          issues.push({ message: `похожие ${what} «${a}» и «${b}»`, locations: [at(a), at(b)] });
        }
      }
    });
  };
  similar("id", elements);
  similar("типы", groupBy(mentions.filter((m) => m.type), (m) => m.type!));

  return issues;
}
