import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('../src/utils/shellSuggestPosition.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
  },
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const { cursorCellToCssPosition } = await import(moduleUrl);

assert.deepEqual(
  cursorCellToCssPosition(
    { cursorX: 12, cursorY: 20, baseY: 0, viewportY: 0 },
    { cellWidth: 7.7, cellHeight: 18.9 },
  ),
  { left: 92.4, top: 378 },
);
assert.deepEqual(
  cursorCellToCssPosition(
    { cursorX: 12, cursorY: 20, baseY: 0, viewportY: 0 },
    { cellWidth: 7.7, cellHeight: 18.9 },
    1.1,
  ),
  { left: 92.4, top: 378 },
);
assert.deepEqual(
  cursorCellToCssPosition(
    { cursorX: 12, cursorY: 20, baseY: 100, viewportY: 98 },
    { cellWidth: 7.7, cellHeight: 18.9 },
  ),
  { left: 92.4, top: 415.79999999999995 },
);

console.log('shellSuggestPosition tests passed');
