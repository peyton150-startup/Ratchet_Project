import type { ReactNode } from 'react';
import {
  COMPARISON_OPS,
  STATE_PREDICATES,
  addCondition,
  childrenOf,
  comparisonParts,
  describeCondition,
  getAt,
  isGroup,
  kindOf,
  literalToText,
  makeComparison,
  parseLiteral,
  removeAt,
  replaceAt,
  setGroupOp,
  toggleNot,
  type ComparisonOp,
  type Condition,
  type Path,
} from '../lib/rules';
import { Button, Toolbar, tokens } from '../components';

const fieldStyle = {
  background: tokens.color.surfaceAlt,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius,
  color: tokens.color.text,
  padding: tokens.space(1),
  fontSize: '13px',
} as const;

// What each "+" button inserts. Every one is valid as inserted except the empty group, which the
// builder flags until it has a condition in it.
const NEW_CONDITION: Array<{ label: string; make: () => Condition }> = [
  { label: '+ comparison', make: () => makeComparison('gt', 'payload.amount', 0) },
  { label: '+ field changed', make: () => ({ changed: 'amount' }) },
  { label: '+ state check', make: () => ({ state: STATE_PREDICATES[0] }) },
  { label: '+ group', make: () => ({ or: [] }) },
];

function AddButtons({ onAdd }: { onAdd: (c: Condition) => void }) {
  return (
    <Toolbar>
      {NEW_CONDITION.map((n) => (
        <Button key={n.label} onClick={() => onAdd(n.make())}>
          {n.label}
        </Button>
      ))}
    </Toolbar>
  );
}

/**
 * Edits a rule's condition tree (ADR-004). A condition is nothing ("always"), one test, or a group
 * of tests joined by ALL/ANY; any node can be negated, and groups nest.
 */
export function ConditionEditor({
  condition,
  onChange,
}: {
  condition: Condition | null;
  onChange: (c: Condition | null) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: '13px', color: tokens.color.textMuted, marginBottom: tokens.space(2) }}>
        {describeCondition(condition)}
      </div>
      {condition === null ? null : <Node root={condition} path={[]} onChange={onChange} />}
      {/* A group carries its own add buttons; these start a condition or extend a single one. */}
      {condition === null || !isGroup(condition) ? (
        <div style={{ marginTop: tokens.space(2) }}>
          <AddButtons onAdd={(c) => onChange(addCondition(condition, [], c))} />
        </div>
      ) : null}
    </div>
  );
}

function Node({ root, path, onChange }: { root: Condition; path: Path; onChange: (c: Condition | null) => void }) {
  const node = getAt(root, path);
  const kind = kindOf(node);
  const edit = (next: Condition) => onChange(replaceAt(root, path, next));
  const remove = () => onChange(removeAt(root, path));
  const negate = () => onChange(toggleNot(root, path));

  const nested = { borderLeft: `2px solid ${tokens.color.border}`, paddingLeft: tokens.space(3) } as const;

  if (kind === 'and' || kind === 'or') {
    return (
      <div style={{ ...nested, margin: `${tokens.space(2)} 0` }}>
        <Toolbar>
          <select
            aria-label="Group type"
            style={fieldStyle}
            value={kind}
            onChange={(e) => onChange(setGroupOp(root, path, e.target.value as 'and' | 'or'))}
          >
            <option value="and">ALL of these</option>
            <option value="or">ANY of these</option>
          </select>
          <Button onClick={negate}>NOT</Button>
          <Button tone="danger" onClick={remove}>
            remove group
          </Button>
        </Toolbar>
        {childrenOf(node).map((_, i) => (
          <Node key={i} root={root} path={[...path, i]} onChange={onChange} />
        ))}
        <div style={{ marginTop: tokens.space(2) }}>
          <AddButtons onAdd={(c) => onChange(addCondition(root, path, c))} />
        </div>
      </div>
    );
  }

  if (kind === 'not') {
    return (
      <div style={{ ...nested, margin: `${tokens.space(2)} 0` }}>
        <Toolbar>
          <strong style={{ fontSize: '13px' }}>NOT</strong>
          <Button onClick={negate}>remove NOT</Button>
        </Toolbar>
        <Node root={root} path={[...path, 0]} onChange={onChange} />
      </div>
    );
  }

  let fields: ReactNode;
  if ('changed' in node) {
    fields = (
      <>
        <span>field</span>
        <input
          aria-label="Changed field"
          style={{ ...fieldStyle, width: '140px' }}
          value={node.changed}
          onChange={(e) => edit({ changed: e.target.value })}
        />
        <span>changed</span>
      </>
    );
  } else if ('state' in node) {
    fields = (
      <>
        <select
          aria-label="State check"
          style={fieldStyle}
          value={node.state}
          onChange={(e) => edit({ state: e.target.value })}
        >
          {STATE_PREDICATES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span>is true</span>
      </>
    );
  } else {
    const { op, ref, value } = comparisonParts(node);
    fields = (
      <>
        <input
          aria-label="Reference"
          style={{ ...fieldStyle, width: '170px' }}
          value={ref}
          placeholder="payload.amount"
          onChange={(e) => edit(makeComparison(op, e.target.value, value))}
        />
        <select
          aria-label="Operator"
          style={fieldStyle}
          value={op}
          onChange={(e) => edit(makeComparison(e.target.value as ComparisonOp, ref, value))}
        >
          {COMPARISON_OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input
          aria-label="Value"
          style={{ ...fieldStyle, width: '150px' }}
          value={literalToText(value)}
          placeholder={op === 'in' ? '["paystub","W2"]' : '500000'}
          onChange={(e) => edit(makeComparison(op, ref, parseLiteral(e.target.value)))}
        />
      </>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: tokens.space(2),
        fontSize: '13px',
        padding: `${tokens.space(2)} 0`,
      }}
    >
      {fields}
      <Button onClick={negate}>NOT</Button>
      <Button tone="danger" onClick={remove}>
        remove
      </Button>
    </div>
  );
}
