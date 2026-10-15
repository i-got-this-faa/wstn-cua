import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import {
  StreamManager,
  JpegStreamParser,
  parseJpegDimensions,
  createSyntheticJpegFrame,
  type VideoFrame,
} from '../src/portal/stream-manager.js';
import {
  parsePwDumpJson,
  parsePwCliText,
  getXdgPortalStreamInfo,
  PortalStreamMetadataSchema,
  XdgPortalStreamInfoSchema,
} from '../src/portal/xdg-portal.js';
import {
  WebrtcPortal,
  parseSdpOffer,
  generateDefaultSdpAnswer,
} from '../src/portal/webrtc-portal.js';

describe('PipeWire Streaming Portal Tests', () => {
  let streamManager: StreamManager;

  beforeEach(() => {
    streamManager = new StreamManager({
      mode: 'manual',
      width: 640,
      height: 480,
      fps: 30,
    });
  });

  afterEach(async () => {
    streamManager.destroy();
    await streamManager.stop();
  });

  // --- Task 1: Frame Ingestion & Atomic Latest Frame Retrieval ---
  describe('Frame Ingestion & Atomic Latest Frame Retrieval', () => {
    it('should initially return null before any frame is ingested', () => {
      expect(streamManager.getLatestFrame()).toBeNull();
    });

    it('should ingest synthetic frames and update latestFrame atomically', () => {
      const frameBuf = createSyntheticJpegFrame(640, 480, 1, Date.now());
      streamManager.pushFrame(frameBuf, 640, 480);

      const latest = streamManager.getLatestFrame();
      expect(latest).not.toBeNull();
      if (!latest) throw new Error('Expected frame');

      expect(latest.frameId).toBe(1);
      expect(latest.width).toBe(640);
      expect(latest.height).toBe(480);
      expect(latest.buffer.length).toBeGreaterThan(100);
      // Valid JPEG markers: SOI (0xFFD8) and EOI (0xFFD9)
      expect(latest.buffer[0]).toBe(0xff);
      expect(latest.buffer[1]).toBe(0xd8);
      expect(latest.buffer[latest.buffer.length - 2]).toBe(0xff);
      expect(latest.buffer[latest.buffer.length - 1]).toBe(0xd9);
    });

    it('should increment frame sequence numbers monotonically', () => {
      for (let i = 1; i <= 5; i++) {
        const buf = createSyntheticJpegFrame(640, 480, i, Date.now());
        streamManager.pushFrame(buf);
      }

      const latest = streamManager.getLatestFrame();
      expect(latest?.frameId).toBe(5);
      const stats = streamManager.getStats();
      expect(stats.totalIngestedFrames).toBe(5);
    });

    it('should achieve sub-1ms retrieval latency on getLatestFrame', () => {
      const frameBuf = createSyntheticJpegFrame(640, 480, 1, Date.now());
      streamManager.pushFrame(frameBuf);

      const iterations = 50_000;
      const start = performance.now();
      let checksum = 0;
      for (let i = 0; i < iterations; i++) {
        const frame = streamManager.getLatestFrame();
        if (frame !== null) {
          checksum += frame.frameId;
        }
      }
      const elapsed = performance.now() - start;
      const avgLatencyMs = elapsed / iterations;

      expect(checksum).toBe(iterations);
      // Average latency should be well under 0.05 ms (50 microseconds, exceeding sub-1ms)
      expect(avgLatencyMs).toBeLessThan(0.05);
    });

    it('should correctly parse JPEG dimensions from SOF0 markers', () => {
      const testJpeg = createSyntheticJpegFrame(64, 64, 1, Date.now());
      const dims = parseJpegDimensions(testJpeg);
      expect(dims).not.toBeNull();
      expect(dims?.width).toBe(64);
      expect(dims?.height).toBe(64);
    });
  });

  // --- JpegStreamParser Chunk Demuxing ---
  describe('JpegStreamParser', () => {
    it('should assemble a frame fragmented across arbitrary chunk boundaries', () => {
      const parser = new JpegStreamParser();
      const rawFrame = createSyntheticJpegFrame(64, 64, 1, Date.now());

      // Slice the frame into 17-byte small chunks
      const chunkSize = 17;
      const parsedFrames: Buffer[] = [];

      for (let offset = 0; offset < rawFrame.length; offset += chunkSize) {
        const slice = rawFrame.subarray(offset, Math.min(offset + chunkSize, rawFrame.length));
        const frames = parser.pushChunk(slice);
        parsedFrames.push(...frames);
      }

      expect(parsedFrames.length).toBe(1);
      const reconstructed = parsedFrames[0];
      if (!reconstructed) throw new Error('Expected reconstructed frame');

      expect(reconstructed.length).toBe(rawFrame.length);
      expect(reconstructed.equals(rawFrame)).toBe(true);
    });

    it('should extract multiple frames sent in a single chunk', () => {
      const parser = new JpegStreamParser();
      const f1 = createSyntheticJpegFrame(64, 64, 1, Date.now());
      const f2 = createSyntheticJpegFrame(64, 64, 2, Date.now());
      const combined = Buffer.concat([f1, f2]);

      const frames = parser.pushChunk(combined);
      expect(frames.length).toBe(2);
      expect(frames[0]?.equals(f1)).toBe(true);
      expect(frames[1]?.equals(f2)).toBe(true);
    });

    it('should discard garbage prefixes before SOI marker', () => {
      const parser = new JpegStreamParser();
      const f1 = createSyntheticJpegFrame(64, 64, 1, Date.now());
      const garbage = Buffer.from('GStreamer-WARNING **: pipeline warning text\nSetting state to PLAYING\n');
      const stream = Buffer.concat([garbage, f1]);

      const frames = parser.pushChunk(stream);
      expect(frames.length).toBe(1);
      expect(frames[0]?.equals(f1)).toBe(true);
    });
  });

  // --- Task 2: WebSocket Streaming Distribution & Backpressure ---
  describe('WebSocket Streaming Distribution & Backpressure', () => {
    let server: http.Server;
    let wss: WebSocketServer;
    let serverPort: number;

    beforeEach(async () => {
      server = http.createServer();
      wss = new WebSocketServer({ noServer: true });

      server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          streamManager.handleWebSocketConnection(ws, req);
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          serverPort = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('should distribute binary frames with 16-byte header to connected WebSocket clients', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/v1/cua/stream?format=binary`);

      const receivedBuffers: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          // Push test frame once connected
          const frame = createSyntheticJpegFrame(640, 480, 42, 1700000000000);
          streamManager.pushFrame(frame, 640, 480, 42);
        });

        ws.on('message', (data: Buffer) => {
          receivedBuffers.push(Buffer.from(data));
          ws.close();
          resolve();
        });

        ws.on('error', reject);
      });

      expect(receivedBuffers.length).toBeGreaterThan(0);
      const packet = receivedBuffers[0];
      if (!packet) throw new Error('Expected packet');

      // 16-byte header verification
      expect(packet.length).toBeGreaterThan(16);
      const frameId = packet.readUInt32BE(0);
      const timestamp = Number(packet.readBigInt64BE(4));
      const width = packet.readUInt16BE(12);
      const height = packet.readUInt16BE(14);
      const jpegPayload = packet.subarray(16);

      expect(frameId).toBe(42);
      expect(timestamp).toBeGreaterThan(0);
      expect(width).toBe(640);
      expect(height).toBe(480);
      expect(jpegPayload[0]).toBe(0xff);
      expect(jpegPayload[1]).toBe(0xd8);
    });

    it('should distribute base64 frames to clients requesting JSON format', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/v1/cua/stream?format=base64`);

      const receivedMessages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          const frame = createSyntheticJpegFrame(320, 240, 99, Date.now());
          streamManager.pushFrame(frame, 320, 240, 99);
        });

        ws.on('message', (data: string | Buffer) => {
          receivedMessages.push(data.toString());
          ws.close();
          resolve();
        });

        ws.on('error', reject);
      });

      expect(receivedMessages.length).toBeGreaterThan(0);
      const parsed = JSON.parse(receivedMessages[0] ?? '{}') as {
        type: string;
        frameId: number;
        width: number;
        height: number;
        data: string;
      };

      expect(parsed.type).toBe('frame');
      expect(parsed.frameId).toBe(99);
      expect(parsed.width).toBe(320);
      expect(parsed.height).toBe(240);
      expect(typeof parsed.data).toBe('string');
      const decodedBuf = Buffer.from(parsed.data, 'base64');
      expect(decodedBuf[0]).toBe(0xff);
      expect(decodedBuf[1]).toBe(0xd8);
    });

    it('should drop intermediary frames for clients under backpressure', () => {
      // Create mock slow WebSocket with simulated bufferedAmount
      const mockSlowWs = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 512 * 1024, // 512KB exceeds default 256KB threshold
        send: () => {},
        on: () => mockSlowWs,
        close: () => {},
      } as unknown as WebSocket;

      const mockFastWs = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        sentMessages: [] as Buffer[],
        send: (data: Buffer) => {
          (mockFastWs as unknown as { sentMessages: Buffer[] }).sentMessages.push(data);
        },
        on: () => mockFastWs,
        close: () => {},
      } as unknown as WebSocket;

      const slowId = streamManager.addWebSocketClient(mockSlowWs, { maxBufferSize: 256 * 1024 });
      streamManager.addWebSocketClient(mockFastWs, { maxBufferSize: 256 * 1024 });

      // Ingest 5 frames
      for (let i = 1; i <= 5; i++) {
        const frame = createSyntheticJpegFrame(640, 480, i, Date.now());
        streamManager.pushFrame(frame);
      }

      const stats = streamManager.getStats();
      const slowStats = stats.clientStats.find((c) => c.id === slowId);
      expect(slowStats).toBeDefined();
      // All 5 frames should have been dropped for the slow client
      expect(slowStats?.droppedFrames).toBe(5);
      expect(slowStats?.sentFrames).toBe(0);

      // Fast client received all 5 frames
      const fastMessages = (mockFastWs as unknown as { sentMessages: Buffer[] }).sentMessages;
      expect(fastMessages.length).toBe(5);
    });
  });

  // --- Task 3: HTTP Multipart MJPEG Stream ---
  describe('HTTP Multipart MJPEG Stream', () => {
    let server: http.Server;
    let serverPort: number;

    beforeEach(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/v1/cua/stream') {
          streamManager.handleMjpegStream(req, res);
        } else {
          res.writeHead(404).end();
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          serverPort = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('should write multipart/x-mixed-replace headers and stream MJPEG chunks', async () => {
      // Ingest an initial frame
      const initialFrame = createSyntheticJpegFrame(640, 480, 101, 1700000000000);
      streamManager.pushFrame(initialFrame, 640, 480, 101);

      const responseChunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${serverPort}/v1/cua/stream`, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toBe('multipart/x-mixed-replace; boundary=frame');

          res.on('data', (chunk: Buffer) => {
            responseChunks.push(Buffer.from(chunk));
            if (responseChunks.length >= 2) {
              req.destroy();
              resolve();
            }
          });

          // Ingest another frame while client is connected
          setTimeout(() => {
            const secondFrame = createSyntheticJpegFrame(640, 480, 102, 1700000001000);
            streamManager.pushFrame(secondFrame, 640, 480, 102);
          }, 20);
        });

        req.on('error', (err) => {
          // Socket hangup after destroy is expected
          if ((err as { code?: string }).code !== 'ECONNRESET') {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const fullOutput = Buffer.concat(responseChunks).toString('binary');
      expect(fullOutput).toContain('--frame\r\n');
      expect(fullOutput).toContain('Content-Type: image/jpeg\r\n');
      expect(fullOutput).toContain('Content-Length:');
      expect(fullOutput).toContain('X-Frame-Id: 101');
    });

    it('should unregister client and free resources on client disconnect', async () => {
      // Push frame so stream emits immediately on connection
      const frame = createSyntheticJpegFrame(640, 480, 1, Date.now());
      streamManager.pushFrame(frame, 640, 480, 1);

      expect(streamManager.getStats().activeMjpegClients).toBe(0);

      let clientReq: http.ClientRequest | null = null;
      await new Promise<void>((resolve) => {
        clientReq = http.get(`http://127.0.0.1:${serverPort}/v1/cua/stream`, (res) => {
          res.once('data', () => {
            expect(streamManager.getStats().activeMjpegClients).toBe(1);
            clientReq?.destroy();
            setTimeout(resolve, 50);
          });
        });
      });

      expect(streamManager.getStats().activeMjpegClients).toBe(0);
    });
  });

  // --- Task 4: Linux XDG Desktop Portal & PipeWire Node Discovery ---
  describe('XDG Portal & PipeWire Node Discovery', () => {
    it('should correctly parse pw-dump JSON and extract weston video nodes', () => {
      const mockPwDump = JSON.stringify([
        {
          id: 42,
          type: 'PipeWire:Interface:Node',
          info: {
            props: {
              'node.name': 'weston.pipewire',
              'media.class': 'Stream/Output/Video',
              'video.width': 1920,
              'video.height': 1080,
              'video.rate': 60,
              'video.format': 'BGRx',
            },
          },
        },
        {
          id: 99,
          type: 'PipeWire:Interface:Node',
          info: {
            props: {
              'node.name': 'alsa_output.pci',
              'media.class': 'Audio/Sink',
            },
          },
        },
      ]);

      const nodes = parsePwDumpJson(mockPwDump, /weston/i);
      expect(nodes.length).toBe(1);
      const westonNode = nodes[0];
      if (!westonNode) throw new Error('Expected node');

      expect(westonNode.nodeId).toBe(42);
      expect(westonNode.nodeName).toBe('weston.pipewire');
      expect(westonNode.width).toBe(1920);
      expect(westonNode.height).toBe(1080);
      expect(westonNode.format).toBe('BGRx');
      expect(westonNode.rate).toBe(60);

      // Validate against Zod schema
      expect(() => PortalStreamMetadataSchema.parse(westonNode)).not.toThrow();
    });

    it('should parse pw-cli text output fallback', () => {
      const mockPwCli = `
	id 55, type PipeWire:Interface:Node/3
 		object.serial = "55"
 		node.name = "weston"
 		media.class = "Video/Source"
	id 60, type PipeWire:Interface:Node/3
 		object.serial = "60"
 		node.name = "dummy-audio"
      `;

      const nodes = parsePwCliText(mockPwCli, /weston/i);
      expect(nodes.length).toBe(1);
      expect(nodes[0]?.nodeId).toBe(55);
      expect(nodes[0]?.nodeName).toBe('weston');
    });

    it('should generate valid XdgPortalStreamInfo conforming to schema', async () => {
      const info = await getXdgPortalStreamInfo(77);
      expect(info.streamId).toBe(77);
      expect(info.pipewireTarget).toBe('path=77');
      expect(typeof info.isPortalAvailable).toBe('boolean');
      expect(() => XdgPortalStreamInfoSchema.parse(info)).not.toThrow();
    });
  });

  // --- Task 5: WebRTC Portal WHEP & JSON Signaling ---
  describe('WebRTC Portal Signaling Interface', () => {
    let webrtcPortal: WebrtcPortal;

    const sampleSdpOffer = [
      'v=0',
      'o=- 81273912739 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'c=IN IP4 0.0.0.0',
      'a=rtcp:9 IN IP4 0.0.0.0',
      'a=ice-ufrag:clientufrag',
      'a=ice-pwd:clientpassword12345678',
      'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF',
      'a=setup:actpass',
      'a=mid:0',
      'a=recvonly',
      'a=rtcp-mux',
      'a=rtpmap:96 VP8/90000',
      '',
    ].join('\r\n');

    beforeEach(() => {
      webrtcPortal = new WebrtcPortal();
    });

    afterEach(() => {
      webrtcPortal.destroy();
    });

    it('should parse SDP offer transport attributes', () => {
      const parsed = parseSdpOffer(sampleSdpOffer);
      expect(parsed.iceUfrag).toBe('clientufrag');
      expect(parsed.icePwd).toBe('clientpassword12345678');
      expect(parsed.mid).toBe('0');
      expect(parsed.codecs.length).toBe(1);
      expect(parsed.codecs[0]?.name).toBe('VP8');
    });

    it('should generate RFC compliant SDP answer matching offer', () => {
      const answer = generateDefaultSdpAnswer(sampleSdpOffer, 'sess123');
      expect(answer).toContain('v=0');
      expect(answer).toContain('s=wstn-cua-webrtc-portal');
      expect(answer).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96');
      expect(answer).toContain('a=setup:active');
      expect(answer).toContain('a=sendonly');
      expect(answer).toContain('a=rtpmap:96 VP8/90000');
    });

    it('should handle WHEP HTTP protocol end-to-end (OPTIONS, POST offer, PATCH candidate, DELETE)', async () => {
      let whepSessionLocation = '';

      // 1. OPTIONS preflight
      const reqOptions = { method: 'OPTIONS', url: '/v1/cua/whep' } as http.IncomingMessage;
      let optionsStatusCode = 0;
      const resOptions = {
        setHeader: () => {},
        writeHead: (code: number) => {
          optionsStatusCode = code;
        },
        end: () => {},
      } as unknown as http.ServerResponse;

      const handledOptions = await webrtcPortal.handleHttpRequest(reqOptions, resOptions);
      expect(handledOptions).toBe(true);
      expect(optionsStatusCode).toBe(204);

      // 2. POST /v1/cua/whep with SDP offer
      const reqOffer = {
        method: 'POST',
        url: '/v1/cua/whep',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(sampleSdpOffer);
        },
      } as unknown as http.IncomingMessage;

      let offerStatusCode = 0;
      let offerHeaders: Record<string, string> = {};
      let answerSdp = '';

      const resOffer = {
        setHeader: () => {},
        writeHead: (code: number, headers?: Record<string, string>) => {
          offerStatusCode = code;
          if (headers) offerHeaders = headers;
        },
        end: (data?: string) => {
          if (data) answerSdp = data;
        },
      } as unknown as http.ServerResponse;

      const handledOffer = await webrtcPortal.handleHttpRequest(reqOffer, resOffer);
      expect(handledOffer).toBe(true);
      expect(offerStatusCode).toBe(201);
      expect(offerHeaders['Content-Type']).toBe('application/sdp');
      expect(offerHeaders['Location']).toBeDefined();
      whepSessionLocation = offerHeaders['Location'] as string;
      expect(answerSdp).toContain('a=sendonly');

      // 3. PATCH trickle ICE candidate
      const reqPatch = {
        method: 'PATCH',
        url: whepSessionLocation,
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host\r\n');
        },
      } as unknown as http.IncomingMessage;

      let patchCode = 0;
      const resPatch = {
        setHeader: () => {},
        writeHead: (code: number) => {
          patchCode = code;
        },
        end: () => {},
      } as unknown as http.ServerResponse;

      const handledPatch = await webrtcPortal.handleHttpRequest(reqPatch, resPatch);
      expect(handledPatch).toBe(true);
      expect(patchCode).toBe(204);

      // 4. DELETE session
      const reqDelete = {
        method: 'DELETE',
        url: whepSessionLocation,
      } as unknown as http.IncomingMessage;

      let deleteCode = 0;
      const resDelete = {
        setHeader: () => {},
        writeHead: (code: number) => {
          deleteCode = code;
        },
        end: () => {},
      } as unknown as http.ServerResponse;

      const handledDelete = await webrtcPortal.handleHttpRequest(reqDelete, resDelete);
      expect(handledDelete).toBe(true);
      expect(deleteCode).toBe(204);
    });

    it('should handle JSON offer/answer signaling endpoints', async () => {
      const offerPayload = JSON.stringify({
        type: 'offer',
        sdp: sampleSdpOffer,
      });

      const reqOffer = {
        method: 'POST',
        url: '/v1/cua/webrtc/offer',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(offerPayload);
        },
      } as unknown as http.IncomingMessage;

      let jsonAnswer = '';
      const resOffer = {
        writeHead: () => {},
        end: (data?: string) => {
          if (data) jsonAnswer = data;
        },
      } as unknown as http.ServerResponse;

      const handled = await webrtcPortal.handleHttpRequest(reqOffer, resOffer);
      expect(handled).toBe(true);
      const parsed = JSON.parse(jsonAnswer) as { type: string; sdp: string; sessionId: string };
      expect(parsed.type).toBe('answer');
      expect(typeof parsed.sessionId).toBe('string');
      expect(parsed.sdp).toContain('a=sendonly');
    });

    it('should reject invalid JSON in WebRTC offer endpoint with 400', async () => {
      const req = {
        method: 'POST',
        url: '/v1/cua/webrtc/offer',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from('{ bad json ...');
        },
      } as unknown as http.IncomingMessage;

      let statusCode = 0;
      let body = '';
      const res = {
        writeHead: (code: number) => {
          statusCode = code;
        },
        end: (data?: string) => {
          if (data) body = data;
        },
      } as unknown as http.ServerResponse;

      const handled = await webrtcPortal.handleHttpRequest(req, res);
      expect(handled).toBe(true);
      expect(statusCode).toBe(400);
      expect(body).toContain('Invalid JSON');
    });

    it('should return 404 for non-existent session ICE candidates', async () => {
      const icePayload = JSON.stringify({
        sessionId: 'nonexistent-session-id',
        candidate: 'candidate:dummy',
      });

      const req = {
        method: 'POST',
        url: '/v1/cua/webrtc/ice',
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(icePayload);
        },
      } as unknown as http.IncomingMessage;

      let statusCode = 0;
      const res = {
        writeHead: (code: number) => {
          statusCode = code;
        },
        end: () => {},
      } as unknown as http.ServerResponse;

      const handled = await webrtcPortal.handleHttpRequest(req, res);
      expect(handled).toBe(true);
      expect(statusCode).toBe(404);
    });
  });

  // --- Task 6: Synthetic & Auto Mode Lifecycle ---
  describe('Synthetic & Auto Mode Lifecycle', () => {
    it('should run synthetic mode periodically and emit frames', async () => {
      const manager = new StreamManager({
        mode: 'synthetic',
        syntheticIntervalMs: 25,
      });

      await manager.start();
      const initialFrame = manager.getLatestFrame();
      expect(initialFrame).not.toBeNull();

      // Wait 70ms to allow interval to generate frames
      await new Promise((r) => setTimeout(r, 70));

      const stats = manager.getStats();
      expect(stats.totalIngestedFrames).toBeGreaterThanOrEqual(2);
      expect(stats.activeMode).toBe('synthetic');

      await manager.stop();
      manager.destroy();
    });
  });
});

