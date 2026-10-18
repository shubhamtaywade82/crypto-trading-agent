import { getPlaybook, validateRegistry } from '../../playbooks/registry.js';
import type { PlaybookDefinition, PlaybookId, PlaybookParams, RuleId, SessionWindow } from '../../playbooks/types.js';
import { SESSION_PRESETS, type ComponentGroup, type ComponentOption, type ExperimentConfig, type GroupSpec, type VariantSpec } from './types.js';

/**
 * The component catalog and the variant generator.
 *
 * A "component group" is one experiment dimension of a playbook (higher-timeframe bias, liquidity sweep, displacement,
 * killzone session, zone kind, ...). A variant turns a fixed set of group options on over a core of mandatory rules, so
 * isolation (core + one), ablation (full - one) and pair (core + two) variants differ from their reference by exactly
 * the components under test. Every generated definition is validated with the same registry validator the live engine
 * uses: a variant can never be weaker than the mandatory core.
 */

const HTF_GROUP: GroupSpec = {
  key: 'htf',
  description: 'Higher-timeframe bias filter on 4h and 1h: weak (not opposed) or strict (fully aligned).',
  options: [
    { key: 'not_opposed', description: 'No bias frame may trend against the trade (htf_not_opposed).', rules: ['htf_not_opposed'] },
    { key: 'aligned', description: 'Every bias frame must trend with the trade (htf_aligned).', rules: ['htf_aligned'] },
  ],
};

const SWEEP_GROUP: GroupSpec = {
  key: 'sweep',
  description: 'Liquidity sweep before the break: the leg must take the prior opposing swing first (liquidity_swept_before_break).',
  options: [
    { key: 'on', description: 'Liquidity must be swept before the structure break.', rules: ['liquidity_swept_before_break'] },
  ],
};

const DISPLACEMENT_GROUP: GroupSpec = {
  key: 'displacement',
  description: 'Displacement: the break candle body must clear minDisplacementAtr zone-frame ATR (displacement_confirmed).',
  options: [
    { key: 'on', description: 'Require the break candle body to clear the displacement threshold.', rules: ['displacement_confirmed'] },
  ],
};

const UNMITIGATED_GROUP: GroupSpec = {
  key: 'unmitigated',
  description: 'Zone freshness: no zone-frame close through the far edge of the zone since the break (zone_unmitigated).',
  options: [
    { key: 'on', description: 'Refuse mitigated zones.', rules: ['zone_unmitigated'] },
  ],
};

const FRESH_GROUP: GroupSpec = {
  key: 'fresh',
  description: 'Setup age: the break may be at most maxSetupAgeBars zone-frame bars old (setup_fresh).',
  options: [
    { key: 'on', description: 'Expire stale setups.', rules: ['setup_fresh'] },
  ],
};

const VOLUME_GROUP: GroupSpec = {
  key: 'volume',
  description: 'Breakout volume: break candle volume over the prior volumeLookback-bar mean (breakout_volume).',
  options: [
    { key: 'on', description: 'Require the break volume multiple.', rules: ['breakout_volume'] },
  ],
};

const DISCOUNT_GROUP: GroupSpec = {
  key: 'discount',
  description: 'Premium/discount: the entry must sit in the discount (LONG) / premium (SHORT) half of the displacement leg (entry_in_discount).',
  options: [
    { key: 'on', description: 'Require the entry inside the discount half of the leg.', rules: ['entry_in_discount'] },
  ],
};

const ZONE_GROUP: GroupSpec = {
  key: 'zone',
  description: 'Zone kind for the continuation entry: registry behaviour is FVG first, then the order block; restrict it to one.',
  options: [
    { key: 'fvg', description: 'Arm only on the displacement leg FVG.', params: { zoneKinds: ['FVG'] } },
    { key: 'ob', description: 'Arm only on the break order block.', params: { zoneKinds: ['ORDER_BLOCK'] } },
  ],
};

const sessionGroup = (windows: readonly SessionWindow[]): ComponentGroup => ({
  key: 'session',
  description: 'Session filter: the trigger close must fall inside the configured UTC windows (session_in_window).',
  registryDefault: null,
  options: [
    { key: 'ict', description: `Trigger close inside the ICT killzones: ${windows.map((w) => w.name).join(', ')}.`, rules: ['session_in_window'], params: { sessionWindows: windows } },
  ],
});

/** The registry's default state per playbook: which group options the published definition has on. */
const REGISTRY_DEFAULTS: Readonly<Record<PlaybookId, Readonly<Record<string, string | null>>>> = {
  sweep_mss_fvg_reversal: { htf: 'not_opposed', sweep: 'on', displacement: 'on', unmitigated: 'on', fresh: 'on', zone: null, session: null },
  bos_fvg_ob_continuation: { htf: 'aligned', sweep: null, displacement: 'on', unmitigated: 'on', fresh: 'on', discount: 'on', zone: null, session: null },
  breakout_retest: { htf: 'not_opposed', sweep: null, displacement: 'on', volume: 'on', fresh: 'on', session: null },
};

const BASE_GROUPS: Readonly<Record<PlaybookId, readonly GroupSpec[]>> = {
  // The sweep reversal arms only on an FVG zone (registry validation refuses OB-only there), so it has no zone group
  sweep_mss_fvg_reversal: [HTF_GROUP, SWEEP_GROUP, DISPLACEMENT_GROUP, UNMITIGATED_GROUP, FRESH_GROUP],
  bos_fvg_ob_continuation: [HTF_GROUP, SWEEP_GROUP, DISPLACEMENT_GROUP, UNMITIGATED_GROUP, FRESH_GROUP, DISCOUNT_GROUP, ZONE_GROUP],
  breakout_retest: [HTF_GROUP, SWEEP_GROUP, DISPLACEMENT_GROUP, VOLUME_GROUP, FRESH_GROUP],
};

/** Component groups of one playbook under the study's session preset. Order is fixed: it defines variant order. */
export function componentCatalog(pbId: PlaybookId, sessionPreset: ExperimentConfig['sessionPreset']): readonly ComponentGroup[] {
  const groups = BASE_GROUPS[pbId];
  if (!groups) throw new Error(`unknown playbook ${pbId}`);
  const withDefaults = groups.map((g) => ({ ...g, registryDefault: REGISTRY_DEFAULTS[pbId][g.key] ?? null }));
  return sessionPreset === 'ict' ? [...withDefaults, sessionGroup(SESSION_PRESETS.ict)] : withDefaults;
}

/** `group` for a single-option group, `group:option` otherwise: the string stored in a variant's components. */
export function componentKey(group: ComponentGroup, option: ComponentOption): string {
  return group.options.length === 1 ? group.key : `${group.key}:${option.key}`;
}

export interface Selection { group: ComponentGroup; option: ComponentOption }

const optionOf = (group: ComponentGroup, key: string | null): ComponentOption | null =>
  key === null ? null : group.options.find((o) => o.key === key) ?? null;

/** The option a group contributes when the config names only the group: the registry default, else the first option. */
const defaultOption = (group: ComponentGroup): ComponentOption => {
  const chosen = optionOf(group, group.registryDefault) ?? group.options[0];
  if (!chosen) throw new Error(`component group ${group.key} has no options`);
  return chosen;
};

const cloneParams = (p: PlaybookParams): PlaybookParams => {
  const out: PlaybookParams = { ...p };
  if (p.sessionWindows) out.sessionWindows = [...p.sessionWindows];
  if (p.zoneKinds) out.zoneKinds = [...p.zoneKinds];
  return out;
};

const allToggleableRules = (groups: readonly ComponentGroup[]): ReadonlySet<string> =>
  new Set(groups.flatMap((g) => g.options.flatMap((o) => o.rules ?? [])));

export function buildVariant(base: PlaybookDefinition, groups: readonly ComponentGroup[], name: string, on: readonly Selection[], paramOverrides: Partial<PlaybookParams>): VariantSpec {
  const toggleable = allToggleableRules(groups);
  const onRules = new Set(on.flatMap(({ option }) => [...(option.rules ?? [])]));
  // Registry order, with every toggleable rule that is off removed and every on rule that the registry does not list
  // (session_in_window, a sweep requirement on a continuation, ...) appended. With every registry-default option on
  // this reproduces the registry definition exactly, so `full` is the registry plus the research param overrides.
  const appended = ([...onRules].filter((r) => !base.rules.includes(r as RuleId)) as RuleId[]);
  const rules: RuleId[] = [...base.rules.filter((r) => !toggleable.has(r) || onRules.has(r)), ...appended];
  const params = cloneParams(base.params);
  for (const { option } of on) Object.assign(params, option.params);
  Object.assign(params, paramOverrides);
  const definition: PlaybookDefinition = { ...base, rules, params };
  // A variant is judged by the same validator as the registry: it can never be weaker than the mandatory core, and
  // params that a rule needs cannot be missing (session windows, leg position, volume thresholds, trigger window).
  validateRegistry([definition]);
  return {
    label: `${base.id}::${name}`,
    playbookId: base.id,
    name,
    components: on.map(({ group, option }) => componentKey(group, option)),
    paramOverrides,
    definition,
  };
}

/**
 * Every variant of the study, in a deterministic order: per playbook, core, full, then isolation, ablation and pair
 * families. Duplicate labels are refused; duplicate definitions (rules and params) would be double-counted evidence,
 * so the second copy is refused too.
 */
export function buildVariants(config: ExperimentConfig): VariantSpec[] {
  const out: VariantSpec[] = [];
  const seenLabels = new Set<string>();
  const seenDefinitions = new Set<string>();
  const push = (v: VariantSpec): void => {
    if (seenLabels.has(v.label)) throw new Error(`duplicate variant label ${v.label}`);
    seenLabels.add(v.label);
    const key = JSON.stringify([v.definition.rules, v.definition.params]);
    if (seenDefinitions.has(key)) throw new Error(`variant ${v.label} duplicates another variant's definition`);
    seenDefinitions.add(key);
    out.push(v);
  };
  for (const pbId of config.playbooks) {
    const base = getPlaybook(pbId);
    const groups = componentCatalog(pbId, config.sessionPreset);
    push(buildVariant(base, groups, 'core', [], config.paramOverrides));
    const fullOn: Selection[] = groups
      .map((group) => ({ group, option: optionOf(group, group.registryDefault) }))
      .filter((s): s is Selection => s.option !== null);
    push(buildVariant(base, groups, 'full', fullOn, config.paramOverrides));
    if (config.isolation) {
      for (const group of groups) {
        for (const option of group.options) {
          push(buildVariant(base, groups, `iso:${componentKey(group, option)}`, [{ group, option }], config.paramOverrides));
        }
      }
    }
    if (config.ablation) {
      for (const on of fullOn) {
        const rest = fullOn.filter((s) => s.group !== on.group);
        push(buildVariant(base, groups, `abl:${on.group.key}`, rest, config.paramOverrides));
      }
    }
    if (config.pairs !== 'none' && config.pairs.length > 0) {
      const chosen = new Map<string, Selection>();
      for (const key of config.pairs) {
        const group = groups.find((g) => g.key === key);
        if (!group) throw new Error(`pairs: playbook ${pbId} has no component group ${key}`);
        chosen.set(key, { group, option: defaultOption(group) });
      }
      const list = [...chosen.values()];
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          push(buildVariant(base, groups, `pair:${list[i].group.key}+${list[j].group.key}`, [list[i], list[j]], config.paramOverrides));
        }
      }
    }
  }
  return out;
}
