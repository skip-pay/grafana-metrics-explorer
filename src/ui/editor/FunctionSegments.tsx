import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { FunctionParam, getFunction } from '../../compile';
import { FunctionCall } from '../../model/types';
import { MenuSelect } from '../MenuSelect';
import { getEditorStyles, ROW_HEIGHT } from './styles';

export interface FunctionSegmentsProps {
  functions: FunctionCall[];
  onChange: (functions: FunctionCall[]) => void;
}

/** Grey captions shown before a parameter, by function name and parameter index. */
const CAPTIONS: Record<string, Array<string | undefined>> = {
  rollup: [undefined, 'every'],
  moving_rollup: [undefined, 'by'],
  fill: [undefined, 'limit'],
  top: [undefined, 'by'],
  bottom: [undefined, 'by'],
};

/** Applied functions as `name [param] [param] ×` segments; parameters are edited in place. */
export const FunctionSegments = ({ functions, onChange }: FunctionSegmentsProps) => (
  <>
    {functions.map((call) => (
      <FunctionSegment
        key={call.id}
        call={call}
        onChange={(next) => onChange(functions.map((f) => (f.id === call.id ? next : f)))}
        onRemove={() => onChange(functions.filter((f) => f.id !== call.id))}
      />
    ))}
  </>
);

interface SegmentProps {
  call: FunctionCall;
  onChange: (call: FunctionCall) => void;
  onRemove: () => void;
}

const FunctionSegment = ({ call, onChange, onRemove }: SegmentProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const def = getFunction(call.name);
  const captions = CAPTIONS[call.name] ?? [];
  const setArg = (index: number, value: number | string) =>
    onChange({
      ...call,
      args: (def?.params ?? []).map((p, j) => (j === index ? value : (call.args[j] ?? p.default))),
    });

  return (
    <span
      className={styles.segment}
      title={def ? def.description : `Unknown function ${call.name}`}
      data-testid="function-segment"
    >
      <span className={cx(editorStyles.label, !def && styles.unknown)}>{call.name}</span>
      {def?.params.map((param, i) => (
        <React.Fragment key={`${call.id}:${param.name}`}>
          {captions[i] && <span className={editorStyles.label}>{captions[i]}</span>}
          <ParamControl param={param} value={call.args[i] ?? param.default} onChange={(v) => setArg(i, v)} />
        </React.Fragment>
      ))}
      <button
        type="button"
        className={editorStyles.segmentButton}
        aria-label={`Remove ${call.name}`}
        onClick={onRemove}
      >
        <Icon name="times" />
      </button>
    </span>
  );
};

interface ParamControlProps {
  param: FunctionParam;
  value: number | string;
  onChange: (value: number | string) => void;
}

const ParamControl = ({ param, value, onChange }: ParamControlProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [draft, setDraft] = useState<string>();

  if (param.kind === 'enum' && param.options) {
    const current = param.options.find((o) => String(o) === String(value)) ?? param.default;
    return (
      <MenuSelect
        variant="segment"
        hideCaret
        value={current}
        options={param.options.map((o) => ({ value: o, label: String(o) }))}
        onChange={onChange}
        ariaLabel={param.name}
      />
    );
  }
  if (param.kind === 'number' && INTERVAL_PARAMS.includes(param.name)) {
    return <IntervalControl param={param} value={Number(value)} onChange={onChange} />;
  }
  // Typing keeps the draft; a valid value is applied right away, an invalid one is dropped on blur.
  return (
    <input
      className={cx(editorStyles.segment, styles.input)}
      type={param.kind === 'number' ? 'number' : 'text'}
      value={draft ?? String(value)}
      aria-label={param.name}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (param.kind !== 'number') {
          onChange(text);
          return;
        }
        const n = Number(text);
        if (text.trim() !== '' && Number.isFinite(n)) {
          onChange(n);
        }
      }}
      onBlur={() => setDraft(undefined)}
    />
  );
};

/** Number parameters in seconds, edited as a number plus a unit. */
const INTERVAL_PARAMS = ['seconds', 'limit'];
const UNITS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'seconds' },
  { value: 60, label: 'minutes' },
  { value: 3600, label: 'hours' },
];

/** The largest unit the value is a whole multiple of. */
function unitOf(seconds: number): number {
  return [...UNITS].reverse().find((u) => seconds !== 0 && seconds % u.value === 0)?.value ?? 1;
}

/** `[300] [seconds]` → shown as `[5] [minutes]` once the field is left; 0 is the automatic interval. */
const IntervalControl = ({ param, value, onChange }: ParamControlProps & { value: number }) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [unit, setUnit] = useState(() => unitOf(value));
  const [draft, setDraft] = useState<string>();
  const shown = value === 0 ? '' : String(value / unit);
  return (
    <>
      <input
        className={cx(editorStyles.segment, styles.input)}
        type="number"
        value={draft ?? shown}
        placeholder="(default)"
        aria-label={param.name}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const n = text.trim() === '' ? 0 : Number(text);
          if (Number.isFinite(n)) {
            onChange(Math.round(n * unit));
          }
        }}
        onBlur={() => {
          setDraft(undefined);
          setUnit(unitOf(value));
        }}
      />
      <MenuSelect
        variant="segment"
        hideCaret
        value={unit}
        options={UNITS}
        onChange={(next) => {
          setUnit(next);
          if (value !== 0) {
            onChange(Math.round((value / unit) * next));
          }
        }}
        ariaLabel={`${param.name} unit`}
      />
    </>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  segment: css({
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    // Joined parts: neighbours share one border.
    '& > * + *': { marginLeft: -1 },
  }),
  unknown: css({
    color: theme.colors.warning.text,
    borderColor: theme.colors.warning.border,
  }),
  input: css({
    width: 72,
    height: ROW_HEIGHT,
    outline: 'none',
    font: 'inherit',
    '&:focus': { borderColor: theme.colors.primary.border, position: 'relative' },
  }),
});
