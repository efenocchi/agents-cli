import type { CDPClient } from './cdp.js';

export interface RefOpts {
  interactive?: boolean;
  limit?: number;
  compact?: boolean;
}

interface AXNode {
  nodeId: string;
  role: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface RefNode {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  backendNodeId?: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'slider',
  'spinbutton',
  'searchbox',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);

export async function getRefs(
  cdp: CDPClient,
  sessionId: string,
  opts: RefOpts = {}
): Promise<{ refs: string; nodeMap: Map<number, RefNode> }> {
  const { interactive = true, limit = 500, compact = false } = opts;

  const { nodes } = (await cdp.send(
    'Accessibility.getFullAXTree',
    {},
    sessionId
  )) as { nodes: AXNode[] };

  const nodeMap = new Map<number, RefNode>();
  const lines: string[] = [];
  let refCounter = 1;

  for (const node of nodes) {
    if (refCounter > limit) break;

    const role = node.role?.value?.toLowerCase() || '';
    if (!role || role === 'none' || role === 'generic') continue;
    if (interactive && !INTERACTIVE_ROLES.has(role)) continue;

    const name = node.name?.value || '';
    const attrs: string[] = [];

    for (const prop of node.properties || []) {
      const propName = prop.name;
      const propValue = prop.value?.value;
      if (propName === 'disabled' && propValue === true) attrs.push('disabled');
      if (propName === 'checked' && propValue === true) attrs.push('checked');
      if (propName === 'selected' && propValue === true) attrs.push('selected');
      if (propName === 'expanded' && propValue === true) attrs.push('expanded');
      if (propName === 'required' && propValue === true) attrs.push('required');
      if (propName === 'readonly' && propValue === true) attrs.push('readonly');
      if (propName === 'invalid' && propValue === true) attrs.push('invalid');
    }

    const ref = refCounter++;
    const refNode: RefNode = {
      ref,
      role,
      name,
      attrs,
      backendNodeId: node.backendDOMNodeId,
    };
    nodeMap.set(ref, refNode);

    const attrStr = attrs.length > 0 ? ` [${attrs.join('] [')}]` : '';
    const nameStr = name ? ` "${truncate(name, 50)}"` : '';
    const line = compact
      ? `${role}${nameStr} [ref=${ref}]${attrStr}`
      : `- ${role}${nameStr} [ref=${ref}]${attrStr}`;
    lines.push(line);
  }

  return { refs: lines.join('\n'), nodeMap };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export async function resolveRefToCoords(
  cdp: CDPClient,
  sessionId: string,
  nodeMap: Map<number, RefNode>,
  ref: number
): Promise<{ x: number; y: number }> {
  const node = nodeMap.get(ref);
  if (!node) throw new Error(`Ref ${ref} not found`);
  if (!node.backendNodeId) throw new Error(`Ref ${ref} has no DOM node`);

  const { model } = (await cdp.send(
    'DOM.getBoxModel',
    { backendNodeId: node.backendNodeId },
    sessionId
  )) as { model: { content: number[] } };

  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;
  const centerX = (x1 + x2 + x3 + x4) / 4;
  const centerY = (y1 + y2 + y3 + y4) / 4;

  return { x: centerX, y: centerY };
}
