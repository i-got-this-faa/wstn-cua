import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

/**
 * Validated schema for PipeWire Portal Stream Metadata.
 */
export const PortalStreamMetadataSchema = z.object({
  nodeId: z.number().int().nonnegative(),
  nodeName: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.string(),
  rate: z.number().positive(),
});

export type PortalStreamMetadata = z.infer<typeof PortalStreamMetadataSchema>;

/**
 * Validated schema for XDG Portal Screencast Stream Information.
 */
export const XdgPortalStreamInfoSchema = z.object({
  streamId: z.number().int().nonnegative(),
  nodeName: z.string(),
  metadata: PortalStreamMetadataSchema,
  pipewireTarget: z.string(),
  isPortalAvailable: z.boolean(),
  portalSessionHandle: z.string().optional(),
});

export type XdgPortalStreamInfo = z.infer<typeof XdgPortalStreamInfoSchema>;

/**
 * Zod schema for pw-dump node props.
 */
const PwDumpNodePropsSchema = z
  .object({
    'node.name': z.string().optional(),
    'node.description': z.string().optional(),
    'media.class': z.string().optional(),
    'media.role': z.string().optional(),
    'video.width': z.union([z.number(), z.string()]).optional(),
    'video.height': z.union([z.number(), z.string()]).optional(),
    'video.format': z.string().optional(),
    'video.rate': z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const PwDumpNodeSchema = z.object({
  id: z.number().int().nonnegative(),
  type: z.string(),
  info: z
    .object({
      props: PwDumpNodePropsSchema.optional(),
      params: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const PwDumpOutputSchema = z.array(z.unknown());

/**
 * Parses raw JSON string from `pw-dump` and extracts video nodes matching the filter pattern.
 */
export function parsePwDumpJson(jsonString: string, filterPattern: RegExp = /weston/i): PortalStreamMetadata[] {
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(jsonString);
  } catch {
    return [];
  }

  const parseResult = PwDumpOutputSchema.safeParse(parsedRaw);
  if (!parseResult.success) {
    return [];
  }

  const results: PortalStreamMetadata[] = [];

  for (const item of parseResult.data) {
    const nodeResult = PwDumpNodeSchema.safeParse(item);
    if (!nodeResult.success) {
      continue;
    }

    const node = nodeResult.data;
    if (node.type !== 'PipeWire:Interface:Node') {
      continue;
    }

    const props = node.info?.props;
    const nodeName = props?.['node.name'] ?? '';
    const nodeDesc = props?.['node.description'] ?? '';
    const mediaClass = props?.['media.class'] ?? '';

    // Match either name, description or if mediaClass is video stream
    const matchesFilter = filterPattern.test(nodeName) || filterPattern.test(nodeDesc);
    const isVideoNode =
      mediaClass.toLowerCase().includes('video') ||
      mediaClass.toLowerCase().includes('stream/output') ||
      nodeName.toLowerCase().includes('video') ||
      matchesFilter;

    if (!matchesFilter && !isVideoNode) {
      continue;
    }

    if (!matchesFilter && filterPattern.source !== '.*') {
      continue;
    }

    const widthRaw = props?.['video.width'];
    const heightRaw = props?.['video.height'];
    const rateRaw = props?.['video.rate'];
    const formatRaw = props?.['video.format'];

    const width = typeof widthRaw === 'number' ? widthRaw : typeof widthRaw === 'string' ? parseInt(widthRaw, 10) : 1920;
    const height = typeof heightRaw === 'number' ? heightRaw : typeof heightRaw === 'string' ? parseInt(heightRaw, 10) : 1080;
    const rate = typeof rateRaw === 'number' ? rateRaw : typeof rateRaw === 'string' ? parseFloat(rateRaw) : 60;
    const format = typeof formatRaw === 'string' && formatRaw.length > 0 ? formatRaw : 'BGRx';

    results.push({
      nodeId: node.id,
      nodeName: nodeName || `pipewire-node-${node.id}`,
      width: Number.isFinite(width) && width > 0 ? width : 1920,
      height: Number.isFinite(height) && height > 0 ? height : 1080,
      format,
      rate: Number.isFinite(rate) && rate > 0 ? rate : 60,
    });
  }

  return results;
}

/**
 * Parses raw text output from `pw-cli list-objects Node` as fallback.
 */
export function parsePwCliText(cliOutput: string, filterPattern: RegExp = /weston/i): PortalStreamMetadata[] {
  const results: PortalStreamMetadata[] = [];
  const blocks = cliOutput.split(/(?=\tid \d+, type PipeWire:Interface:Node)/g);

  for (const block of blocks) {
    const idMatch = block.match(/id\s+(\d+),\s*type\s+PipeWire:Interface:Node/);
    if (!idMatch || idMatch[1] === undefined) {
      continue;
    }

    const nodeId = parseInt(idMatch[1], 10);
    const nameMatch = block.match(/node\.name\s*=\s*"([^"]+)"/);
    const classMatch = block.match(/media\.class\s*=\s*"([^"]+)"/);
    const nodeName = nameMatch?.[1] ?? `node-${nodeId}`;
    const mediaClass = classMatch?.[1] ?? '';

    if (!filterPattern.test(nodeName) && !filterPattern.test(mediaClass)) {
      continue;
    }

    results.push({
      nodeId,
      nodeName,
      width: 1920,
      height: 1080,
      format: 'BGRx',
      rate: 60,
    });
  }

  return results;
}

/**
 * Queries PipeWire for active video nodes. Tries `pw-dump` first, then falls back to `pw-cli`.
 */
export async function queryPipeWireNodes(filterPattern: RegExp = /weston/i): Promise<PortalStreamMetadata[]> {
  // 1. Try pw-dump
  try {
    const { stdout } = await execFileAsync('pw-dump', [], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 3000,
    });
    const parsed = parsePwDumpJson(stdout, filterPattern);
    if (parsed.length > 0) {
      return parsed;
    }
  } catch {
    // fallback to pw-cli
  }

  // 2. Try pw-cli list-objects Node
  try {
    const { stdout } = await execFileAsync('pw-cli', ['list-objects', 'Node'], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 3000,
    });
    return parsePwCliText(stdout, filterPattern);
  } catch {
    return [];
  }
}

/**
 * Helper to query PipeWire specifically for active video nodes matching "weston" or "weston.pipewire".
 */
export async function queryActiveWestonNode(): Promise<PortalStreamMetadata | null> {
  const nodes = await queryPipeWireNodes(/weston(?:\.pipewire)?/i);
  if (nodes.length === 0) {
    return null;
  }
  // Return the first matching node
  return nodes[0] ?? null;
}

/**
 * Checks if the host desktop environment has an active XDG Desktop Portal service.
 */
export async function isXdgPortalAvailable(): Promise<boolean> {
  // Check D-Bus session bus names for org.freedesktop.portal.Desktop
  try {
    const { stdout } = await execFileAsync(
      'dbus-send',
      [
        '--session',
        '--dest=org.freedesktop.DBus',
        '--type=method_call',
        '--print-reply',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.ListNames',
      ],
      { timeout: 2000 }
    );
    return stdout.includes('org.freedesktop.portal.Desktop');
  } catch {
    // If dbus-send fails, inspect common desktop environment indicators
    const hasWaylandOrX11 = Boolean(process.env['WAYLAND_DISPLAY'] || process.env['DISPLAY']);
    const hasDbus = Boolean(process.env['DBUS_SESSION_BUS_ADDRESS']);
    return hasWaylandOrX11 && hasDbus;
  }
}

/**
 * Returns portal-compatible screencast stream info so agents can discover the stream ID.
 */
export async function getXdgPortalStreamInfo(overrideNodeId?: number): Promise<XdgPortalStreamInfo> {
  const isPortal = await isXdgPortalAvailable();

  let metadata: PortalStreamMetadata | null = null;
  if (overrideNodeId !== undefined) {
    const allNodes = await queryPipeWireNodes(/.*/);
    const matched = allNodes.find((n) => n.nodeId === overrideNodeId);
    if (matched) {
      metadata = matched;
    } else {
      metadata = {
        nodeId: overrideNodeId,
        nodeName: `pipewire-node-${overrideNodeId}`,
        width: 1920,
        height: 1080,
        format: 'BGRx',
        rate: 60,
      };
    }
  } else {
    metadata = await queryActiveWestonNode();
  }

  // If no live Weston node is active, construct fallback portal descriptor
  if (metadata === null) {
    metadata = {
      nodeId: 0,
      nodeName: 'weston.pipewire.virtual',
      width: 1280,
      height: 720,
      format: 'BGRx',
      rate: 30,
    };
  }

  const streamInfo: XdgPortalStreamInfo = {
    streamId: metadata.nodeId,
    nodeName: metadata.nodeName,
    metadata,
    pipewireTarget: `path=${metadata.nodeId}`,
    isPortalAvailable: isPortal,
    portalSessionHandle: `/org/freedesktop/portal/desktop/session/wstn_${metadata.nodeId}`,
  };

  return XdgPortalStreamInfoSchema.parse(streamInfo);
}
