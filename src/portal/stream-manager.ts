import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { appRootDir } from '../paths.js';
import { queryPipeWireNodes } from './xdg-portal.js';

/**
 * Validated schema for StreamManager options and runtime configurations.
 */
export const StreamManagerConfigSchema = z.object({
  mode: z.enum(['auto', 'native', 'gstreamer', 'synthetic', 'manual']).default('auto'),
  targetNode: z.union([z.string(), z.number()]).optional(),
  nativeBinaryPath: z.string().optional(),
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720),
  fps: z.number().int().positive().default(30),
  jpegQuality: z.number().int().min(1).max(100).default(80),
  syntheticIntervalMs: z.number().int().positive().default(100),
  maxClientBufferSize: z.number().int().positive().default(256 * 1024),
});

export type StreamManagerConfig = z.infer<typeof StreamManagerConfigSchema>;
export type StreamMode = StreamManagerConfig['mode'];
export type WebSocketFrameFormat = 'binary' | 'base64';

export type FrameId = number & { readonly __brand: unique symbol };
export type ClientId = string & { readonly __brand: unique symbol };

export function toFrameId(id: number): FrameId {
  return id as FrameId;
}

export function toClientId(id: string): ClientId {
  return id as ClientId;
}

/**
 * Complete video frame representation stored in memory.
 */
export interface VideoFrame {
  readonly buffer: Buffer;
  readonly timestamp: number;
  readonly width: number;
  readonly height: number;
  readonly frameId: number;
}

export interface WebSocketClientOptions {
  readonly format?: WebSocketFrameFormat | undefined;
  readonly maxBufferSize?: number | undefined;
}

export interface ClientStats {
  readonly id: string;
  readonly format: WebSocketFrameFormat;
  readonly sentFrames: number;
  readonly droppedFrames: number;
  readonly bufferedAmount: number;
}

export interface StreamManagerStats {
  readonly activeMode: StreamMode;
  readonly isRunning: boolean;
  readonly totalIngestedFrames: number;
  readonly latestFrameId: number;
  readonly activeWebSocketClients: number;
  readonly activeMjpegClients: number;
  readonly clientStats: readonly ClientStats[];
}

interface InternalClient {
  readonly id: ClientId;
  readonly ws: WebSocket;
  readonly format: WebSocketFrameFormat;
  readonly maxBufferSize: number;
  sentFrames: number;
  droppedFrames: number;
}

/**
 * Fast JPEG dimension parser. Extracts width and height from SOF0/SOF2 markers without native dependencies.
 */
export function parseJpegDimensions(buffer: Buffer): { readonly width: number; readonly height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  const len = buffer.length;

  while (offset < len - 1) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === undefined || marker === 0x00 || marker === 0xff) {
      offset += 1;
      continue;
    }

    // SOS (Start of Scan) or EOI: headers end here
    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    if (offset + 4 > len) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    // SOF0 (0xc0) or SOF2 (0xc2)
    if (marker === 0xc0 || marker === 0xc2) {
      if (offset + 9 <= len) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
      break;
    }

    offset += 2 + segmentLength;
  }

  return null;
}

/**
 * High-performance chunk-to-frame JPEG stream parser.
 * Handles continuous byte streams containing concatenated JPEG frames (from stdout of gst-launch or pw_stream).
 */
export class JpegStreamParser {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxBufferSize: number;

  public constructor(maxBufferSize = 16 * 1024 * 1024) {
    this.maxBufferSize = maxBufferSize;
  }

  public pushChunk(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) {
      return [];
    }

    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }

    if (this.buffer.length > this.maxBufferSize) {
      // Discard older bytes to avoid unbounded memory growth under corrupted stream
      const searchWindow = this.buffer.subarray(this.buffer.length - 1024 * 1024);
      const soi = this.findSequence(searchWindow, 0xff, 0xd8);
      if (soi !== -1) {
        this.buffer = searchWindow.subarray(soi);
      } else {
        this.buffer = Buffer.alloc(0);
        return [];
      }
    }

    const frames: Buffer[] = [];

    while (this.buffer.length >= 4) {
      const soiIndex = this.findSequence(this.buffer, 0xff, 0xd8);
      if (soiIndex === -1) {
        // No SOI in remaining buffer, retain at most 1 byte in case 0xFF is split
        this.buffer = this.buffer[this.buffer.length - 1] === 0xff ? this.buffer.subarray(this.buffer.length - 1) : Buffer.alloc(0);
        break;
      }

      // Discard any garbage before SOI
      if (soiIndex > 0) {
        this.buffer = this.buffer.subarray(soiIndex);
      }

      // Look for EOI starting from byte 2
      const eoiIndex = this.findSequence(this.buffer, 0xff, 0xd9, 2);
      if (eoiIndex === -1) {
        // Incomplete frame, wait for more chunks
        break;
      }

      const frameEnd = eoiIndex + 2;
      const frameBuffer = Buffer.from(this.buffer.subarray(0, frameEnd));
      frames.push(frameBuffer);
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }

  public clear(): void {
    this.buffer = Buffer.alloc(0);
  }

  private findSequence(buf: Buffer, b1: number, b2: number, start = 0): number {
    for (let i = start; i < buf.length - 1; i += 1) {
      if (buf[i] === b1 && buf[i + 1] === b2) {
        return i;
      }
    }
    return -1;
  }
}

/**
 * Valid embedded baseline JPEG for synthetic frame generation when running headless or in test mode.
 */
const BASE64_SYNTHETIC_JPEG =
  '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' +
  'S2hvP+P/2Q==';

const RAW_SYNTHETIC_JPEG = Buffer.from(BASE64_SYNTHETIC_JPEG, 'base64');

/**
 * Creates a synthetic JPEG frame with an embedded timestamp and sequence ID in an APP1 / COM marker.
 */
export function createSyntheticJpegFrame(width: number, height: number, frameId: number, timestamp: number): Buffer {
  // Insert comment marker containing JSON metadata right after SOI (index 2)
  const metaString = JSON.stringify({ frameId, timestamp, width, height });
  const metaBuf = Buffer.from(metaString, 'utf8');
  const comMarker = Buffer.alloc(4 + metaBuf.length);
  comMarker[0] = 0xff;
  comMarker[1] = 0xfe; // COM marker
  comMarker.writeUInt16BE(2 + metaBuf.length, 2);
  metaBuf.copy(comMarker, 4);

  const header = RAW_SYNTHETIC_JPEG.subarray(0, 2);
  const rest = RAW_SYNTHETIC_JPEG.subarray(2);

  return Buffer.concat([header, comMarker, rest]);
}

/**
 * Core PipeWire & GStreamer Video Streaming Portal Manager for CUA.
 */
export class StreamManager {
  private readonly config: StreamManagerConfig;
  private activeMode: StreamMode;
  private isRunning = false;

  private latestFrame: VideoFrame | null = null;
  private frameSequence = 0;
  private totalIngestedFrames = 0;

  private childProcess: ChildProcess | null = null;
  private parser: JpegStreamParser = new JpegStreamParser();
  private syntheticTimer: ReturnType<typeof setInterval> | null = null;

  private readonly clients = new Map<ClientId, InternalClient>();
  private readonly mjpegListeners = new Map<string, (frame: VideoFrame) => void>();
  private readonly frameListeners = new Set<(frame: VideoFrame) => void>();
  private mjpegCounter = 0;

  public constructor(config?: Partial<StreamManagerConfig>) {
    this.config = StreamManagerConfigSchema.parse(config ?? {});
    this.activeMode = this.config.mode;
  }

  /**
   * Returns the latest complete frame in memory with atomic reference access (zero-latency, sub-1ms).
   */
  public getLatestFrame(): VideoFrame | null {
    return this.latestFrame;
  }

  /**
   * Starts ingestion according to configured mode.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    switch (this.config.mode) {
      case 'native': {
        const started = await this.startNativeStream();
        if (!started) {
          throw new Error('Failed to start native PipeWire stream: binary not found or failed to spawn');
        }
        break;
      }
      case 'gstreamer': {
        const started = await this.startGstreamerStream();
        if (!started) {
          throw new Error('Failed to start GStreamer PipeWire pipeline');
        }
        break;
      }
      case 'synthetic': {
        this.startSyntheticStream();
        break;
      }
      case 'manual': {
        this.activeMode = 'manual';
        break;
      }
      case 'auto':
      default: {
        await this.startAutoStream();
        break;
      }
    }
  }

  /**
   * Stops frame ingestion and cleans up child processes and timers.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;

    if (this.syntheticTimer !== null) {
      clearInterval(this.syntheticTimer);
      this.syntheticTimer = null;
    }

    if (this.childProcess !== null) {
      const proc = this.childProcess;
      this.childProcess = null;

      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();

      try {
        proc.kill('SIGTERM');
      } catch {
        // process may have already exited
      }

      await new Promise<void>((resolve) => {
        const forceKillTimeout = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 300);

        proc.once('exit', () => {
          clearTimeout(forceKillTimeout);
          resolve();
        });
      });
    }

    this.parser.clear();
  }

  /**
   * Destroys the manager and closes all client connections.
   */
  public destroy(): void {
    void this.stop();

    // Close all active WebSockets
    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, 'Stream manager stopped');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.mjpegListeners.clear();
    this.frameListeners.clear();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    this.destroy();
    await this.stop();
  }

  /**
   * Manually pushes a raw JPEG frame into the stream manager (useful for testing and external capture bridges).
   */
  public pushFrame(
    buffer: Buffer,
    explicitWidth?: number,
    explicitHeight?: number,
    explicitFrameId?: number
  ): void {
    const dimensions = parseJpegDimensions(buffer);
    const width = explicitWidth ?? dimensions?.width ?? this.config.width;
    const height = explicitHeight ?? dimensions?.height ?? this.config.height;

    if (explicitFrameId !== undefined) {
      this.frameSequence = explicitFrameId;
    } else {
      this.frameSequence += 1;
    }
    this.totalIngestedFrames += 1;

    const frame: VideoFrame = {
      buffer,
      timestamp: Date.now(),
      width,
      height,
      frameId: this.frameSequence,
    };

    // Atomic reference update
    this.latestFrame = frame;

    // Distribute to all consumers
    this.broadcastToWebSockets(frame);
    this.broadcastToMjpeg(frame);
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // listener error should not break distributor
      }
    }
  }

  /**
   * Subscribes to every newly ingested frame.
   */
  public onFrame(listener: (frame: VideoFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  /**
   * HTTP Multipart MJPEG stream handler.
   * Delivers standard MJPEG chunks suitable for `<img src="/v1/cua/stream">` or HTTP streaming clients.
   */
  public handleMjpegStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate, pre-check=0, post-check=0, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      Connection: 'close',
      'Access-Control-Allow-Origin': '*',
    });

    const listenerId = `mjpeg_${++this.mjpegCounter}`;
    let isDrainPending = false;

    const sendFrame = (frame: VideoFrame): void => {
      if (res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }

      if (isDrainPending) {
        // Drop intermediary frames under HTTP backpressure so consumer stays live
        return;
      }

      const boundaryHeader =
        `--frame\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `Content-Length: ${frame.buffer.length}\r\n` +
        `X-Timestamp: ${frame.timestamp}\r\n` +
        `X-Frame-Id: ${frame.frameId}\r\n\r\n`;

      const chunk = Buffer.concat([Buffer.from(boundaryHeader, 'ascii'), frame.buffer, Buffer.from('\r\n', 'ascii')]);

      const canContinue = res.write(chunk);
      if (!canContinue) {
        isDrainPending = true;
        res.once('drain', () => {
          isDrainPending = false;
        });
      }
    };

    const cleanup = (): void => {
      this.mjpegListeners.delete(listenerId);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    };

    // If an initial frame is available, flush it immediately
    const current = this.latestFrame;
    if (current !== null) {
      sendFrame(current);
    }

    this.mjpegListeners.set(listenerId, sendFrame);

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Adds an active WebSocket client to receive live frames with sequence number, timestamp, and backpressure handling.
   */
  public addWebSocketClient(ws: WebSocket, options?: WebSocketClientOptions): string {
    const clientId = toClientId(`ws_${Math.random().toString(36).substring(2, 10)}`);
    const format = options?.format ?? 'binary';
    const maxBufferSize = options?.maxBufferSize ?? this.config.maxClientBufferSize;

    const client: InternalClient = {
      id: clientId,
      ws,
      format,
      maxBufferSize,
      sentFrames: 0,
      droppedFrames: 0,
    };

    this.clients.set(clientId, client);

    const onWsClose = (): void => {
      this.clients.delete(clientId);
    };

    ws.on('close', onWsClose);
    ws.on('error', onWsClose);

    // Immediately send the latest frame if present and socket is open
    if (this.latestFrame !== null && ws.readyState === WebSocket.OPEN) {
      this.sendToClient(client, this.latestFrame);
    }

    return clientId;
  }

  /**
   * Removes a WebSocket client by its ID.
   */
  public removeWebSocketClient(clientId: string): boolean {
    const client = this.clients.get(toClientId(clientId));
    if (!client) {
      return false;
    }
    this.clients.delete(client.id);
    try {
      client.ws.close();
    } catch {
      // ignore
    }
    return true;
  }

  /**
   * Convenience helper to handle incoming WebSocket upgrades/connections on `/v1/cua/stream`.
   */
  public handleWebSocketConnection(ws: WebSocket, req?: IncomingMessage): string {
    let format: WebSocketFrameFormat = 'binary';
    if (req?.url) {
      try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const formatQuery = parsedUrl.searchParams.get('format');
        if (formatQuery === 'base64' || formatQuery === 'binary') {
          format = formatQuery;
        }
      } catch {
        // fallback to default
      }
    }

    return this.addWebSocketClient(ws, { format });
  }

  /**
   * Current streaming statistics and client health metrics.
   */
  public getStats(): StreamManagerStats {
    const clientStats: ClientStats[] = [];
    for (const client of this.clients.values()) {
      clientStats.push({
        id: client.id,
        format: client.format,
        sentFrames: client.sentFrames,
        droppedFrames: client.droppedFrames,
        bufferedAmount: client.ws.bufferedAmount,
      });
    }

    return {
      activeMode: this.activeMode,
      isRunning: this.isRunning,
      totalIngestedFrames: this.totalIngestedFrames,
      latestFrameId: this.frameSequence,
      activeWebSocketClients: this.clients.size,
      activeMjpegClients: this.mjpegListeners.size,
      clientStats,
    };
  }

  // --- Private Stream Ingestion Pipelines ---

  private async startAutoStream(): Promise<void> {
    // 1. Native pw_stream with TurboJPEG: connects strictly to weston.pipewire (never touches hardware camera)
    if (await this.startNativeStream()) {
      return;
    }

    // 2. Synthetic frame generator fallback
    this.startSyntheticStream();
  }

  private async startNativeStream(): Promise<boolean> {
    const candidates = [
      this.config.nativeBinaryPath,
      process.env['PW_STREAM_BIN'],
      `${appRootDir}/src/native/pw_stream`,
      `${appRootDir}/dist/native/pw_stream`,
      `${process.cwd()}/src/native/pw_stream`,
      `${process.cwd()}/pw_stream`,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);

    let binaryPath: string | null = null;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        binaryPath = candidate;
        break;
      }
    }

    if (binaryPath === null) {
      return false;
    }

    const args: string[] = [];
    if (this.config.targetNode !== undefined) {
      args.push('--node', String(this.config.targetNode));
    }
    args.push('--width', String(this.config.width));
    args.push('--height', String(this.config.height));
    args.push('--fps', String(this.config.fps));
    args.push('--quality', String(this.config.jpegQuality));

    try {
      const child = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.setupProcessHandlers(child, 'native');
      this.childProcess = child;
      this.activeMode = 'native';
      return true;
    } catch {
      return false;
    }
  }

  private async startGstreamerStream(): Promise<boolean> {
    let targetNode: string | number = this.config.targetNode !== undefined ? this.config.targetNode : 'weston.pipewire';

    try {
      const westonNodes = await queryPipeWireNodes(/weston/i);
      if (westonNodes.length > 0) {
        targetNode = westonNodes[0]!.nodeId;
      } else if (this.config.mode === 'auto') {
        // In auto mode, if weston node is not in PipeWire, don't spawn gst (it would grab the webcam!)
        return false;
      }
    } catch {
      if (this.config.mode === 'auto') {
        return false;
      }
    }

    const pipelineArgs = [
      '-q',
      'pipewiresrc',
      `target-object=${targetNode}`,
      '!',
      'video/x-raw',
      '!',
      'videoconvert',
      '!',
      'jpegenc',
      `quality=${this.config.jpegQuality}`,
      '!',
      'fdsink',
      'fd=1',
    ];

    try {
      const child = spawn('gst-launch-1.0', pipelineArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let spawnedOk = false;
      await new Promise<void>((resolve) => {
        child.once('spawn', () => {
          spawnedOk = true;
          resolve();
        });
        child.once('error', () => {
          spawnedOk = false;
          resolve();
        });
      });

      if (!spawnedOk) {
        return false;
      }

      this.setupProcessHandlers(child, 'gstreamer');
      this.childProcess = child;
      this.activeMode = 'gstreamer';
      return true;
    } catch {
      return false;
    }
  }

  private startSyntheticStream(): void {
    this.activeMode = 'synthetic';
    if (this.syntheticTimer !== null) {
      clearInterval(this.syntheticTimer);
    }

    // Immediately push initial synthetic frame
    const initialBuf = createSyntheticJpegFrame(
      this.config.width,
      this.config.height,
      this.frameSequence + 1,
      Date.now()
    );
    this.pushFrame(initialBuf, this.config.width, this.config.height);

    this.syntheticTimer = setInterval(() => {
      if (!this.isRunning) {
        return;
      }
      const frameBuf = createSyntheticJpegFrame(
        this.config.width,
        this.config.height,
        this.frameSequence + 1,
        Date.now()
      );
      this.pushFrame(frameBuf, this.config.width, this.config.height);
    }, this.config.syntheticIntervalMs);
  }

  private setupProcessHandlers(child: ChildProcess, mode: StreamMode): void {
    child.stdout?.on('data', (chunk: Buffer) => {
      const frames = this.parser.pushChunk(chunk);
      for (const frame of frames) {
        this.pushFrame(frame);
      }
    });

    child.on('error', () => {
      if (this.config.mode === 'auto' && this.isRunning) {
        this.startSyntheticStream();
      }
    });

    child.on('exit', () => {
      if (this.config.mode === 'auto' && this.isRunning && this.activeMode === mode) {
        this.startSyntheticStream();
      }
    });
  }

  // --- WebSocket & MJPEG Broadcasting with Backpressure ---

  private broadcastToWebSockets(frame: VideoFrame): void {
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      // Backpressure check: If client socket buffer is saturated, drop intermediary frame
      if (client.ws.bufferedAmount > client.maxBufferSize) {
        client.droppedFrames += 1;
        continue;
      }

      this.sendToClient(client, frame);
    }
  }

  private sendToClient(client: InternalClient, frame: VideoFrame): void {
    if (client.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      if (client.format === 'binary') {
        // Binary packet with 16-byte header:
        // [0..3]: frameId (uint32 BE)
        // [4..11]: timestamp in ms (bigint64 BE)
        // [12..13]: width (uint16 BE)
        // [14..15]: height (uint16 BE)
        // [16..]: raw JPEG frame buffer
        const header = Buffer.allocUnsafe(16);
        header.writeUInt32BE(frame.frameId, 0);
        header.writeBigInt64BE(BigInt(frame.timestamp), 4);
        header.writeUInt16BE(frame.width, 12);
        header.writeUInt16BE(frame.height, 14);

        const packet = Buffer.concat([header, frame.buffer]);
        client.ws.send(packet, { binary: true });
      } else {
        const payload = JSON.stringify({
          type: 'frame',
          frameId: frame.frameId,
          timestamp: frame.timestamp,
          width: frame.width,
          height: frame.height,
          data: frame.buffer.toString('base64'),
        });
        client.ws.send(payload);
      }

      client.sentFrames += 1;
    } catch {
      client.droppedFrames += 1;
    }
  }

  private broadcastToMjpeg(frame: VideoFrame): void {
    for (const listener of this.mjpegListeners.values()) {
      try {
        listener(frame);
      } catch {
        // continue delivering to other clients
      }
    }
  }
}
