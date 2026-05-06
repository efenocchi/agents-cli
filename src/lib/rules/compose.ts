/**
 * Rules composition — assemble a fully-inlined rules document from layered
 * `subrules/` fragments and `rules.yaml` preset definitions.
 *
 * The model:
 *   - Every DotAgents repo holds `<repo>/rules/subrules/*.md` (rule fragments)
 *     and `<repo>/rules/rules.yaml` (preset definitions).
 *   - Layers are read in precedence order (highest first):
 *       project > user > extra > system.
 *   - The active preset's `subrules:` list is resolved against the layer set
 *     using per-name shadowing — a project subrule shadows a user/system one
 *     of the same name.
 *   - Subrules in the user / extra / project layers that the preset did NOT
 *     name are auto-appended in precedence order. (System auto-append is
 *     opt-in only: system never auto-appends to avoid noise.)
 *   - Output is a single concatenated string with no `@-import` syntax.
 *
 * No filesystem writes happen here — callers (`syncResourcesToVersion`,
 * project-rules compile) decide where to land the composed output.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  getResolvedRulesDir,
  getUserRulesDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';

export type LayerScope = 'project' | 'user' | 'extra' | 'system';

export interface RulesLayer {
  scope: LayerScope;
  rulesDir: string;
  /** Set when scope is 'extra'; undefined otherwise. */
  alias?: string;
}

export interface PresetDef {
  /** Subrule names (without `.md`), in concatenation order. */
  subrules: string[];
}

export interface RulesYaml {
  presets?: Record<string, PresetDef>;
}

export interface ComposeOptions {
  /** Defaults to `"default"`. */
  preset?: string;
  /** Layers in precedence order, highest first. */
  layers: RulesLayer[];
}

export interface ComposedSubrule {
  name: string;
  sourcePath: string;
  layerScope: LayerScope;
  layerAlias?: string;
}

export interface ComposeResult {
  /** Fully concatenated, no @-imports. */
  content: string;
  /** The preset name that was applied. */
  preset: string;
  /** The layer that defined the preset. */
  presetLayer: LayerScope;
  /** Subrules included, in concatenation order. */
  subrules: ComposedSubrule[];
}

const SUBRULES_DIR_NAME = 'subrules';
const RULES_YAML_NAME = 'rules.yaml';
const DEFAULT_PRESET = 'default';
const SUBRULES_README = 'README.md';

function readRulesYaml(rulesDir: string): RulesYaml | null {
  const p = path.join(rulesDir, RULES_YAML_NAME);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = yaml.parse(fs.readFileSync(p, 'utf-8')) as RulesYaml | null;
    return parsed || {};
  } catch {
    return null;
  }
}

function resolvePreset(
  layers: RulesLayer[],
  preset: string
): { def: PresetDef; layer: RulesLayer } | null {
  for (const layer of layers) {
    const yml = readRulesYaml(layer.rulesDir);
    if (!yml?.presets) continue;
    const def = yml.presets[preset];
    if (def) return { def, layer };
  }
  return null;
}

function findSubrule(
  layers: RulesLayer[],
  name: string
): { sourcePath: string; layer: RulesLayer } | null {
  for (const layer of layers) {
    const p = path.join(layer.rulesDir, SUBRULES_DIR_NAME, `${name}.md`);
    if (fs.existsSync(p)) return { sourcePath: p, layer };
  }
  return null;
}

function listLayerSubruleNames(layer: RulesLayer): string[] {
  const dir = path.join(layer.rulesDir, SUBRULES_DIR_NAME);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== SUBRULES_README)
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Compose a rules document from the given layers.
 *
 * Throws when the requested preset isn't defined in any layer's rules.yaml —
 * means the caller passed a typo or no layer ships the named preset.
 */
export function composeRules(opts: ComposeOptions): ComposeResult {
  const presetName = opts.preset || DEFAULT_PRESET;

  const presetMatch = resolvePreset(opts.layers, presetName);
  if (!presetMatch) {
    throw new Error(
      `Preset "${presetName}" not found in any rules.yaml across the active layers.`
    );
  }

  const composed: ComposedSubrule[] = [];
  const seen = new Set<string>();

  // 1. Preset's named subrules, resolved by per-name shadowing.
  for (const name of presetMatch.def.subrules || []) {
    if (seen.has(name)) continue;
    const found = findSubrule(opts.layers, name);
    if (!found) continue; // missing subrule: skip silently — same as @-import miss
    composed.push({
      name,
      sourcePath: found.sourcePath,
      layerScope: found.layer.scope,
      layerAlias: found.layer.alias,
    });
    seen.add(name);
  }

  // 2. Auto-append: any subrule in a non-system layer not yet included.
  //    Honors precedence — project layer's auto-appends come first.
  for (const layer of opts.layers) {
    if (layer.scope === 'system') continue;
    for (const name of listLayerSubruleNames(layer)) {
      if (seen.has(name)) continue;
      composed.push({
        name,
        sourcePath: path.join(layer.rulesDir, SUBRULES_DIR_NAME, `${name}.md`),
        layerScope: layer.scope,
        layerAlias: layer.alias,
      });
      seen.add(name);
    }
  }

  // 3. Concatenate. Trim trailing whitespace on each fragment so spacing is
  //    predictable — fragments often end in a newline already.
  const parts = composed.map((c) => fs.readFileSync(c.sourcePath, 'utf-8').replace(/\s+$/, ''));
  const content = parts.length === 0 ? '' : parts.join('\n\n') + '\n';

  return {
    content,
    preset: presetName,
    presetLayer: presetMatch.layer.scope,
    subrules: composed,
  };
}

/**
 * Discover layers for use at sync time (no cwd) or runtime (with cwd).
 *
 * Project layer is included only when cwd is given AND `<cwd>/.agents/rules/`
 * exists. Without cwd, only user / extras / system are surfaced — matching
 * the home-file write at sync time.
 */
export function discoverRulesLayers(opts: { cwd?: string } = {}): RulesLayer[] {
  const layers: RulesLayer[] = [];

  if (opts.cwd) {
    const projectAgentsDir = getProjectAgentsDir(opts.cwd);
    if (projectAgentsDir) {
      const rulesDir = path.join(projectAgentsDir, 'rules');
      if (fs.existsSync(rulesDir)) {
        layers.push({ scope: 'project', rulesDir });
      }
    }
  }

  const userRulesDir = getUserRulesDir();
  if (fs.existsSync(userRulesDir)) {
    layers.push({ scope: 'user', rulesDir: userRulesDir });
  }

  for (const extra of getEnabledExtraRepos()) {
    const rulesDir = path.join(extra.dir, 'rules');
    if (fs.existsSync(rulesDir)) {
      layers.push({ scope: 'extra', rulesDir, alias: extra.alias });
    }
  }

  const systemRulesDir = getResolvedRulesDir();
  if (fs.existsSync(systemRulesDir)) {
    layers.push({ scope: 'system', rulesDir: systemRulesDir });
  }

  return layers;
}

/** Convenience wrapper — discovers layers from state, then composes. */
export function composeRulesFromState(opts: { preset?: string; cwd?: string } = {}): ComposeResult {
  const layers = discoverRulesLayers({ cwd: opts.cwd });
  return composeRules({ preset: opts.preset, layers });
}
