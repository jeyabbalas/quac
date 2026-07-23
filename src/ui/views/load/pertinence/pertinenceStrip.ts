/**
 * PertinenceStrip (json-schema-subsystem.md §E.5 + ui-design.md §4): the
 * one-line data↔schema fit verdict under the slot cards, plus the block
 * modal. Recomputes whenever the dataset, schema, or rules slot changes; the
 * "continue anyway" override is keyed to the exact (setId, generation) pair
 * so any input change re-arms the gate.
 *
 * P12: the strip additionally carries a rules-coverage line (distinct rule
 * targets ∩ dataset columns) in its own element (.q-pertinence-rules — the
 * schema line's .q-pertinence-text stays byte-stable for the pinned e2e), and
 * per ingestion.md §1 it now appears for Dataset + Rules without a schema.
 * The block modal stays schema-driven.
 */
import './pertinence.css';
import { effect, signal } from '../../../../app/signals';
import { openModal } from '../../../../app/modal';
import { computePertinence } from '../../../../core/pertinence';
import type { PertinenceResult } from '../../../../core/pertinence';
import { rulesState } from '../../../../core/rules/rules-store';
import { columnDigest } from '../../../../core/schema/column-meta';
import { schemaState } from '../../../../core/schema/schema-store';
import { createBadge } from '../../../components/badge';
import type { ShellContext } from '../../../../app/shell';

const BADGES = {
  ok: { text: 'OK', tone: 'valid' },
  warn: { text: 'Warning', tone: 'warning' },
  block: { text: 'Blocked', tone: 'error' },
} as const;

function summaryText(result: PertinenceResult, declaredCount: number): string {
  const missing = result.missingRequired.length + result.missingOptional.length;
  const parts = [
    `Pertinence: ${String(result.matched.length)}/${String(declaredCount)} schema variables present`,
    `${String(missing)} missing`,
    `${String(result.extra.length)} extra`,
  ];
  if (result.caseMismatches.length > 0) {
    const n = result.caseMismatches.length;
    parts.push(`${String(n)} case mismatch${n === 1 ? '' : 'es'}`);
  }
  return parts.join(' · ');
}

/** §E.5 block-modal copy; stronger phrasing at score 0. */
function blockCopy(result: PertinenceResult, declaredCount: number): string {
  const missing = [...result.missingRequired, ...result.missingOptional];
  const examples = missing.slice(0, 5).join(', ');
  if (result.matched.length === 0) {
    return (
      `None of the schema's ${String(declaredCount)} variables appear in this dataset ` +
      `(missing ${examples}…). This is almost certainly the wrong file for this schema. ` +
      'Load a different file, or continue anyway.'
    );
  }
  return (
    `This dataset doesn't look like it matches the schema — ${String(result.matched.length)} of ` +
    `${String(declaredCount)} expected variables found (e.g., missing ${examples}…). ` +
    'Load a different file, or continue anyway.'
  );
}

export function mountPertinenceStrip(host: HTMLElement, ctx: ShellContext): void {
  const strip = document.createElement('div');
  strip.className = 'q-pertinence';
  strip.hidden = true;
  host.append(strip);

  /** (setId:generation) the user chose to continue past; null = none. */
  const overrideKey = signal<string | null>(null);
  /** Keys the block modal already opened for — one prompt per input pair. */
  const prompted = new Set<string>();

  const render = (
    result: PertinenceResult,
    declaredCount: number,
    verdict: PertinenceResult['verdict'],
    onContinue: () => void,
  ): void => {
    strip.replaceChildren();
    strip.className = `q-pertinence q-pertinence--${verdict}`;
    const badge = BADGES[verdict];
    strip.append(createBadge(badge.text, badge.tone));
    const text = document.createElement('p');
    text.className = 'q-pertinence-text';
    text.textContent = summaryText(result, declaredCount);
    strip.append(text);
    const firstMismatch = result.caseMismatches[0];
    if (firstMismatch !== undefined) {
      const note = document.createElement('p');
      note.className = 'q-pertinence-note';
      note.textContent =
        `Found column '${firstMismatch.dataset}'; the schema defines ` +
        `'${firstMismatch.schema}'. Rename the column to validate it.`;
      strip.append(note);
    }
    if (verdict === 'block') {
      const cont = document.createElement('button');
      cont.type = 'button';
      cont.className = 'q-pertinence-continue';
      cont.textContent = 'Continue anyway';
      cont.addEventListener('click', onContinue);
      strip.append(cont);
    }
    strip.hidden = false;
  };

  const openBlockModal = (
    result: PertinenceResult,
    declaredCount: number,
    onContinue: () => void,
  ): void => {
    let confirmed = false;
    const handle = openModal({ title: "This data doesn't match the schema" });
    const body = document.createElement('p');
    body.className = 'q-pertinence-modaltext';
    body.textContent = blockCopy(result, declaredCount);
    const actions = document.createElement('div');
    actions.className = 'q-idxpick-actions';
    const continueButton = document.createElement('button');
    continueButton.type = 'button';
    continueButton.className = 'q-btn';
    continueButton.textContent = 'Continue anyway';
    continueButton.addEventListener('click', () => {
      confirmed = true;
      handle.close();
      onContinue();
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'q-btn';
    dismiss.textContent = 'Load a different file';
    dismiss.addEventListener('click', () => {
      if (!confirmed) handle.close();
    });
    actions.append(continueButton, dismiss);
    handle.body.append(body, actions);
  };

  effect(() => {
    const dataset = ctx.store.dataset.get();
    const schema = schemaState.get();
    const rules = rulesState.get();
    const override = overrideKey.get();

    if (dataset === null) {
      strip.hidden = true;
      return;
    }

    // Rules coverage: distinct targets across all loaded files' executable
    // rule types (external never runs — engine §7 exempts it).
    const targets = [
      ...new Set(
        rules.files.flatMap((f) =>
          f.file.rules
            .filter((r) => r.ruleType === 'validate' || r.ruleType === 'correct')
            .flatMap((r) => r.targetVariables),
        ),
      ),
    ];
    const rulesResult =
      targets.length === 0
        ? null
        : computePertinence({
            schemaColumns: targets.map((name) => ({ name, required: true })),
            datasetColumns: dataset.columns,
          });
    const rulesLine =
      rulesResult === null
        ? null
        : `Rules pertinence: ${String(rulesResult.matched.length)}/${String(targets.length)} ` +
          `rule targets present · ${String(rulesResult.missingRequired.length)} missing`;

    const digest = schema.set === null ? null : columnDigest(schema.set);
    const result =
      digest === null
        ? null
        : computePertinence({
            schemaColumns: digest.meta.map((m) => ({ name: m.name, required: m.required })),
            datasetColumns: dataset.columns,
          });

    if (result !== null && digest !== null && schema.set !== null) {
      const key = `${schema.set.setId}:${String(dataset.generation)}`;
      const overridden = override === key;
      // Continue-anyway downgrades block → warn (§E.5).
      const verdict = result.verdict === 'block' && overridden ? 'warn' : result.verdict;
      const onContinue = (): void => {
        overrideKey.set(key);
      };
      render(result, digest.meta.length, verdict, onContinue);
      if (rulesLine !== null) strip.append(renderRulesLine(rulesLine));

      if (verdict === 'block' && !prompted.has(key)) {
        prompted.add(key);
        openBlockModal(result, digest.meta.length, onContinue);
      }
      return;
    }

    // Dataset + rules, no schema (ingestion.md §1: "Schema OR Rules").
    if (rulesLine !== null && rulesResult !== null) {
      const ok = rulesResult.missingRequired.length === 0;
      strip.replaceChildren();
      strip.className = `q-pertinence q-pertinence--${ok ? 'ok' : 'warn'}`;
      strip.append(
        createBadge(ok ? 'OK' : 'Warning', ok ? 'valid' : 'warning'),
        renderRulesLine(rulesLine),
      );
      strip.hidden = false;
      return;
    }

    strip.hidden = true;
  });
}

function renderRulesLine(text: string): HTMLParagraphElement {
  const line = document.createElement('p');
  line.className = 'q-pertinence-rules';
  line.textContent = text;
  return line;
}
