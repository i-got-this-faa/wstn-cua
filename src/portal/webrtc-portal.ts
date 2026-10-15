import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Validated schema for JSON-based WebRTC SDP offer request.
 */
export const WebrtcOfferPayloadSchema = z.object({
  sdp: z.string().min(1, 'SDP offer cannot be empty'),
  type: z.literal('offer').default('offer'),
  clientId: z.string().optional(),
});

export type WebrtcOfferPayload = z.infer<typeof WebrtcOfferPayloadSchema>;

/**
 * Validated schema for WebRTC ICE candidate submission.
 */
export const WebrtcIcePayloadSchema = z.object({
  sessionId: z.string().min(1),
  candidate: z.union([
    z.string(),
    z.object({
      candidate: z.string(),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    }),
  ]),
});

export type WebrtcIcePayload = z.infer<typeof WebrtcIcePayloadSchema>;

/**
 * Validated schema for closing a WebRTC session.
 */
export const WebrtcClosePayloadSchema = z.object({
  sessionId: z.string().min(1),
});

export type WebrtcClosePayload = z.infer<typeof WebrtcClosePayloadSchema>;

export type WebrtcSessionId = string & { readonly __brand: unique symbol };

export function toSessionId(id: string): WebrtcSessionId {
  return id as WebrtcSessionId;
}

export interface WebrtcSession {
  readonly id: WebrtcSessionId;
  readonly createdAt: number;
  lastActivityAt: number;
  readonly offerSdp: string;
  readonly answerSdp: string;
  readonly iceCandidates: string[];
  status: 'created' | 'connected' | 'closed';
}

export interface WebrtcSessionSummary {
  readonly id: string;
  readonly status: 'created' | 'connected' | 'closed';
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly candidateCount: number;
}

export type SdpAnswerGenerator = (offerSdp: string, sessionId: string) => Promise<string> | string;

export interface WebrtcPortalOptions {
  readonly sdpAnswerGenerator?: SdpAnswerGenerator | undefined;
  readonly sessionTimeoutMs?: number | undefined;
  readonly basePath?: string | undefined;
}

/**
 * Parses key transport attributes from an SDP offer string.
 */
export function parseSdpOffer(sdp: string): {
  readonly iceUfrag: string | null;
  readonly icePwd: string | null;
  readonly fingerprint: string | null;
  readonly mid: string | null;
  readonly codecs: readonly { readonly payloadType: number; readonly name: string; readonly clockRate: number }[];
  readonly isSendRecv: boolean;
} {
  const lines = sdp.split(/\r?\n/);
  let iceUfrag: string | null = null;
  let icePwd: string | null = null;
  let fingerprint: string | null = null;
  let mid: string | null = null;
  let isSendRecv = true;
  const codecs: { payloadType: number; name: string; clockRate: number }[] = [];

  for (const line of lines) {
    if (line.startsWith('a=ice-ufrag:')) {
      iceUfrag = line.substring('a=ice-ufrag:'.length).trim();
    } else if (line.startsWith('a=ice-pwd:')) {
      icePwd = line.substring('a=ice-pwd:'.length).trim();
    } else if (line.startsWith('a=fingerprint:')) {
      fingerprint = line.substring('a=fingerprint:'.length).trim();
    } else if (line.startsWith('a=mid:')) {
      mid = line.substring('a=mid:'.length).trim();
    } else if (line.startsWith('a=sendonly')) {
      isSendRecv = false;
    } else if (line.startsWith('a=recvonly')) {
      isSendRecv = false;
    } else if (line.startsWith('a=rtpmap:')) {
      // e.g. a=rtpmap:96 VP8/90000
      const match = line.match(/^a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\/(\d+)/);
      if (match && match[1] && match[2] && match[3]) {
        codecs.push({
          payloadType: parseInt(match[1], 10),
          name: match[2].toUpperCase(),
          clockRate: parseInt(match[3], 10),
        });
      }
    }
  }

  return { iceUfrag, icePwd, fingerprint, mid, codecs, isSendRecv };
}

/**
 * Generates an RFC 8866 / RFC 4566 compliant SDP answer for a video stream in response to a client's offer.
 */
export function generateDefaultSdpAnswer(offerSdp: string, sessionId: string): string {
  const parsed = parseSdpOffer(offerSdp);

  // Match preferred video codec from offer (VP8 > H264 > first available)
  const preferred =
    parsed.codecs.find((c) => c.name === 'VP8') ??
    parsed.codecs.find((c) => c.name === 'H264') ??
    parsed.codecs[0] ??
    { payloadType: 96, name: 'VP8', clockRate: 90000 };

  const serverUfrag = randomBytes(4).toString('hex');
  const serverPwd = randomBytes(16).toString('hex');
  const midStr = parsed.mid ?? '0';

  // Synthetic local DTLS fingerprint placeholder for browser WebRTC negotiation
  const serverFingerprint =
    parsed.fingerprint !== null
      ? parsed.fingerprint
      : 'sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';

  const sdpLines: string[] = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=wstn-cua-webrtc-portal',
    't=0 0',
    `a=group:BUNDLE ${midStr}`,
    'a=msid-semantic: WMS wstn_stream',
    `m=video 9 UDP/TLS/RTP/SAVPF ${preferred.payloadType}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${serverUfrag}`,
    `a=ice-pwd:${serverPwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${serverFingerprint}`,
    'a=setup:active',
    `a=mid:${midStr}`,
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    `a=rtpmap:${preferred.payloadType} ${preferred.name}/${preferred.clockRate}`,
    `a=rtcp-fb:${preferred.payloadType} nack`,
    `a=rtcp-fb:${preferred.payloadType} nack pli`,
    `a=rtcp-fb:${preferred.payloadType} ccm fir`,
    'a=ssrc:11223344 cname:wstn-video',
    'a=ssrc:11223344 msid:wstn_stream wstn_video_track',
    '',
  ];

  return sdpLines.join('\r\n');
}

/**
 * WebRTC Portal Signaling Manager for WSTN-CUA.
 * Implements WHEP (WebRTC HTTP Egress Protocol) and standard JSON SDP offer-answer endpoints.
 */
export class WebrtcPortal {
  private readonly sessions = new Map<WebrtcSessionId, WebrtcSession>();
  private readonly sdpAnswerGenerator: SdpAnswerGenerator;
  private readonly sessionTimeoutMs: number;
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  public constructor(options?: WebrtcPortalOptions) {
    this.sdpAnswerGenerator = options?.sdpAnswerGenerator ?? generateDefaultSdpAnswer;
    this.sessionTimeoutMs = options?.sessionTimeoutMs ?? 5 * 60 * 1000;

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60 * 1000);
  }

  /**
   * Creates a new WebRTC streaming session from an SDP offer and returns the session object with answer SDP.
   */
  public async createSession(offerSdp: string): Promise<WebrtcSession> {
    const rawId = randomBytes(12).toString('hex');
    const sessionId = toSessionId(rawId);

    const answerSdp = await this.sdpAnswerGenerator(offerSdp, rawId);
    const now = Date.now();

    const session: WebrtcSession = {
      id: sessionId,
      createdAt: now,
      lastActivityAt: now,
      offerSdp,
      answerSdp,
      iceCandidates: [],
      status: 'created',
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Adds an ICE candidate fragment to an active session.
   */
  public addIceCandidate(sessionId: string, candidate: string): boolean {
    const session = this.sessions.get(toSessionId(sessionId));
    if (!session || session.status === 'closed') {
      return false;
    }
    session.iceCandidates.push(candidate);
    session.lastActivityAt = Date.now();
    return true;
  }

  /**
   * Closes a session.
   */
  public closeSession(sessionId: string): boolean {
    const session = this.sessions.get(toSessionId(sessionId));
    if (!session) {
      return false;
    }
    session.status = 'closed';
    this.sessions.delete(session.id);
    return true;
  }

  /**
   * Retrieves an active session by ID.
   */
  public getSession(sessionId: string): WebrtcSession | null {
    return this.sessions.get(toSessionId(sessionId)) ?? null;
  }

  /**
   * Returns a list of active session summaries.
   */
  public listSessions(): WebrtcSessionSummary[] {
    const list: WebrtcSessionSummary[] = [];
    this.sessions.forEach((s) => {
      list.push({
        id: s.id,
        status: s.status,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        candidateCount: s.iceCandidates.length,
      });
    });
    return list;
  }

  /**
   * Comprehensive HTTP router for WHEP and JSON WebRTC signaling endpoints.
   * Returns true if the request was handled, false if unhandled (letting other routes proceed).
   */
  public async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const urlString = req.url ?? '/';
    const parsedUrl = new URL(urlString, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase() ?? 'GET';

    // 1. WHEP CORS Preflight
    if (method === 'OPTIONS' && (pathname === '/v1/cua/whep' || pathname.startsWith('/v1/cua/whep/'))) {
      this.sendWhepCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return true;
    }

    // 2. WHEP Initial Offer: POST /v1/cua/whep
    if (method === 'POST' && pathname === '/v1/cua/whep') {
      const rawBody = await this.readRequestBody(req);
      if (rawBody.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Empty SDP offer in WHEP request' }));
        return true;
      }

      const session = await this.createSession(rawBody);

      this.sendWhepCorsHeaders(res);
      res.writeHead(201, {
        'Content-Type': 'application/sdp',
        Location: `/v1/cua/whep/sessions/${session.id}`,
      });
      res.end(session.answerSdp);
      return true;
    }

    // 3. WHEP Trickle ICE: PATCH /v1/cua/whep/sessions/:sessionId
    const whepSessionMatch = pathname.match(/^\/v1\/cua\/whep\/sessions\/([a-zA-Z0-9_-]+)$/);
    if (whepSessionMatch && whepSessionMatch[1]) {
      const sessionId = whepSessionMatch[1];

      if (method === 'PATCH') {
        const candidateBody = await this.readRequestBody(req);
        const ok = this.addIceCandidate(sessionId, candidateBody);
        this.sendWhepCorsHeaders(res);
        if (!ok) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'WHEP session not found' }));
          return true;
        }
        res.writeHead(204);
        res.end();
        return true;
      }

      if (method === 'DELETE') {
        const ok = this.closeSession(sessionId);
        this.sendWhepCorsHeaders(res);
        if (!ok) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'WHEP session not found' }));
          return true;
        }
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    // 4. JSON WebRTC Offer: POST /v1/cua/webrtc/offer
    if (method === 'POST' && pathname === '/v1/cua/webrtc/offer') {
      const body = await this.readRequestBody(req);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return true;
      }

      const validation = WebrtcOfferPayloadSchema.safeParse(parsedJson);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid offer parameters', details: validation.error.format() }));
        return true;
      }

      const session = await this.createSession(validation.data.sdp);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          type: 'answer',
          sdp: session.answerSdp,
          sessionId: session.id,
        })
      );
      return true;
    }

    // 5. JSON WebRTC ICE Candidate: POST /v1/cua/webrtc/ice
    if (method === 'POST' && pathname === '/v1/cua/webrtc/ice') {
      const body = await this.readRequestBody(req);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return true;
      }

      const validation = WebrtcIcePayloadSchema.safeParse(parsedJson);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid ICE candidate payload', details: validation.error.format() }));
        return true;
      }

      const candidateStr =
        typeof validation.data.candidate === 'string'
          ? validation.data.candidate
          : JSON.stringify(validation.data.candidate);

      const ok = this.addIceCandidate(validation.data.sessionId, candidateStr);
      if (!ok) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return true;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ok: true, sessionId: validation.data.sessionId }));
      return true;
    }

    // 6. JSON WebRTC Close: POST /v1/cua/webrtc/close
    if (method === 'POST' && pathname === '/v1/cua/webrtc/close') {
      const body = await this.readRequestBody(req);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return true;
      }

      const validation = WebrtcClosePayloadSchema.safeParse(parsedJson);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid close payload', details: validation.error.format() }));
        return true;
      }

      const ok = this.closeSession(validation.data.sessionId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ok, sessionId: validation.data.sessionId }));
      return true;
    }

    // 7. GET /v1/cua/webrtc/sessions
    if (method === 'GET' && pathname === '/v1/cua/webrtc/sessions') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ sessions: this.listSessions() }));
      return true;
    }

    return false;
  }

  public destroy(): void {
    clearInterval(this.cleanupInterval);
    this.sessions.clear();
  }

  public [Symbol.dispose](): void {
    this.destroy();
  }

  private sendWhepCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-Match');
    res.setHeader('Access-Control-Expose-Headers', 'Location, Link');
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const toDelete: WebrtcSessionId[] = [];
    this.sessions.forEach((session, id) => {
      if (now - session.lastActivityAt > this.sessionTimeoutMs) {
        toDelete.push(id);
      }
    });
    for (const id of toDelete) {
      this.sessions.delete(id);
    }
  }

  private async readRequestBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
