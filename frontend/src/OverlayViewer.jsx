import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './api';
import WebSR from '@websr/websr';

// Async generator that yields individual JPEG frame Blobs from an MJPEG stream.
// Frames decoded from local Blob data are never cross-origin tainted, so they
// can be safely passed to WebGPU's copyExternalImageToTexture.
async function* mjpegFrames(src, signal) {
  const response = await fetch(src, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`Stream HTTP ${response.status}`);

  const ct = response.headers.get('content-type') || '';
  const m = ct.match(/boundary=([^\s;]+)/i);
  if (!m) throw new Error('No multipart boundary in Content-Type');
  const boundaryBytes = new TextEncoder().encode(`--${m[1]}`);
  const CRLF2 = new Uint8Array([13, 10, 13, 10]);
  const CL_RE = /content-length:\s*(\d+)/i;

  function indexOf(hay, needle) {
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  const reader = response.body.getReader();
  let buf = new Uint8Array(0);
  try {
    // signal already aborted before we got here
    if (signal?.aborted) { await reader.cancel(); return; }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf); next.set(value, buf.length);
      buf = next;

      while (true) {
        const bIdx = indexOf(buf, boundaryBytes);
        if (bIdx === -1) break;
        const hStart = bIdx + boundaryBytes.length;
        const hEndRel = indexOf(buf.subarray(hStart), CRLF2);
        if (hEndRel === -1) break;
        const hEnd = hStart + hEndRel + 4;
        const header = new TextDecoder().decode(buf.subarray(hStart, hStart + hEndRel));
        const clMatch = CL_RE.exec(header);
        if (!clMatch) { buf = buf.subarray(hEnd); continue; }
        const len = parseInt(clMatch[1], 10);
        if (buf.length < hEnd + len) break;
        yield new Blob([buf.subarray(hEnd, hEnd + len)], { type: 'image/jpeg' });
        buf = buf.subarray(hEnd + len);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export default function OverlayViewer({ id }) {
  const imgRef      = useRef(null);  // fallback only
  const canvasRef   = useRef(null);
  const [status, setStatus] = useState('init'); // 'init' | 'ready' | 'fallback'

  const src = apiUrl(`/stream/${id}`);

  useEffect(() => {
    let dead      = false;
    let rafId     = null;
    let rendering = false;
    let frameCount = 0;
    // Latest decoded blob, updated by the frame-reader task, consumed by the render loop
    let latestBlob = null;
    const abortCtrl = new AbortController();

    (async () => {
      try {
        console.log('[WebSR] Initializing WebGPU…');
        const gpu = await WebSR.initWebGPU();
        if (dead || !gpu) {
          console.warn('[WebSR] WebGPU unavailable — falling back to plain MJPEG');
          setStatus('fallback'); return;
        }
        console.log('[WebSR] WebGPU ready', gpu);

        console.log('[WebSR] Fetching weights…');
        const weights = await fetch('/weights/cnn-2x-s-rl.json').then(r => r.json());
        if (dead) return;
        console.log('[WebSR] Weights loaded');

        if (!canvasRef.current) {
          console.error('[WebSR] Output canvas not mounted — falling back');
          setStatus('fallback'); return;
        }

        const websr = new WebSR({
          network_name: 'anime4k/cnn-2x-s',
          weights,
          gpu,
          canvas: canvasRef.current,
        });
        console.log('[WebSR] Instance created (network: anime4k/cnn-2x-s, 2× real-life)');
        setStatus('ready');
        console.log('[WebSR] Status → ready, starting frame reader + render loop');

        // Frame reader: continuously fetch MJPEG frames and keep only the latest.
        // Blobs are created from raw bytes, so createImageBitmap() is never tainted.
        (async () => {
          try {
            for await (const blob of mjpegFrames(src, abortCtrl.signal)) {
              if (dead) break;
              latestBlob = blob; // overwrite; old blob is just GC'd
            }
          } catch (err) {
            const isAbort = err?.name === 'AbortError' || err instanceof DOMException;
            if (!isAbort) {
              console.error('[WebSR] Frame reader error', err);
              if (!dead) setStatus('fallback');
            }
          }
        })().catch(() => {}); // prevent unhandled-rejection on abort

        // Render loop: on each animation frame, render the latest available blob.
        function loop() {
          if (dead) return;
          rafId = requestAnimationFrame(loop);
          if (!latestBlob || rendering) return;
          const blob = latestBlob;
          latestBlob = null;
          rendering = true;
          createImageBitmap(blob)
            .then(async (bitmap) => {
              if (dead) { rendering = false; return; }
              try {
                await websr.render(bitmap);
                frameCount++;
                if (frameCount === 1) {
                  const out = canvasRef.current;
                  console.log(`[WebSR] First upscaled frame — output canvas: ${out?.width}×${out?.height}`);
                } else if (frameCount % 100 === 0) {
                  console.log(`[WebSR] ${frameCount} frames upscaled`);
                }
              } finally {
                rendering = false;
              }
            })
            .catch(err => { console.error('[WebSR] Render error', err); rendering = false; });
        }
        rafId = requestAnimationFrame(loop);
      } catch (err) {
        console.error('[WebSR] Init error', err);
        if (!dead) setStatus('fallback');
      }
    })();

    return () => {
      dead = true;
      abortCtrl.abort();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [id]);

  const onError = (e) => {
    const el = e.currentTarget;
    setTimeout(() => { el.src = `${src}?t=${Date.now()}`; }, 1000);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Fallback: plain MJPEG img — only shown when WebGPU is unavailable */}
      <img
        ref={imgRef}
        src={src}
        alt=""
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          display: status === 'fallback' ? 'block' : 'none',
        }}
        onError={onError}
      />

      {/* WebSR upscaled output — CSS width/height scales the large canvas (4096×3072) down to fit */}
      <canvas
        ref={canvasRef}
        style={{
          display: status === 'ready' ? 'block' : 'none',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />

      {status === 'init' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#555', fontSize: 11, pointerEvents: 'none',
        }}>
          Initializing AI upscaling…
        </div>
      )}
    </div>
  );
}

