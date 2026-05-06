import { useEffect, useState } from 'react';
import { apiFetch, apiUrl } from './api';
import CameraFeed from './CameraFeed';
import OverlayViewer from './OverlayViewer';
import Login from './Login';
import Settings from './Settings';
import RecordingsManager from './RecordingsManager';
import './App.css';

export default function App() {
  const [cameras, setCameras]   = useState([]);
  const [expanded, setExpanded] = useState(null);
  // null = unknown (checking), false = not logged in, true = logged in
  const [authed, setAuthed] = useState(null);
  const [serverDown, setServerDown] = useState(false);
  const [bell, setBell] = useState(null); // { id, name } | null

  const [uiScale, setUiScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem('uiScale'));
    return isNaN(saved) ? 1.0 : saved;
  });

  const handleScaleChange = (val) => {
    setUiScale(val);
    localStorage.setItem('uiScale', val);
  };

  // Subscribe to bell events
  useEffect(() => {
    if (!authed) return;
    let es;
    let destroyed = false;
    const connect = () => {
      es = new EventSource(apiUrl('/bell-events'), { withCredentials: true });
      es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setBell(data);
        // Auto-dismiss after 8 s
        setTimeout(() => setBell(b => b === data ? null : b), 8000);
      };
      es.onerror = () => {
        es.close();
        if (!destroyed) setTimeout(connect, 3000);
      };
    };
    connect();
    return () => { destroyed = true; es?.close(); };
  }, [authed]);

  // On mount check if the session cookie is still valid
  useEffect(() => {
    apiFetch('/me').then(r => setAuthed(r.ok)).catch(() => setAuthed(false));
  }, []);

  const handleLogout = async () => {
    await apiFetch('/logout', { method: 'POST' });
    setAuthed(false);
    setCameras([]);
    setExpanded(null);
  };

  // Subscribe to SSE only when authenticated, with automatic reconnection
  useEffect(() => {
    if (!authed) return;

    let es;
    let retryTimer;
    let retryDelay = 1000; // start at 1 s, cap at 30 s
    let destroyed  = false;

    const connect = () => {
      es = new EventSource(apiUrl('/events'), { withCredentials: true });

      es.onmessage = (e) => {
        retryDelay = 1000; // reset backoff on successful message
        setServerDown(false);
        const list = JSON.parse(e.data);
        setCameras(list);
        setExpanded((prev) => (prev && list.some((c) => c.id === prev) ? prev : null));
      };

      es.onerror = () => {
        es.close();
        if (destroyed) return;
        setServerDown(true);

        // Check whether the session is still valid or if we need to re-login
        apiFetch('/me').then(r => {
          if (destroyed) return;
          if (!r.ok) {
            // Server is up but session is gone → go to login
            setServerDown(false);
            setAuthed(false);
          } else {
            // Server is down / reloading → retry with backoff
            retryTimer = setTimeout(() => {
              if (!destroyed) connect();
            }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
          }
        }).catch(() => {
          if (destroyed) return;
          // Server unreachable → retry with backoff
          retryTimer = setTimeout(() => {
            if (!destroyed) connect();
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        });
      };
    };

    connect();

    return () => {
      destroyed = true;
      clearTimeout(retryTimer);
      es?.close();
    };
  }, [authed]);

  // Close overlay on Escape key
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const count = cameras.length;
  const expandedCam = cameras.find((c) => c.id === expanded);

  if (authed === null) return <div className="auth-loading" />;
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  return (
    <div className="viewer" style={{ zoom: uiScale }}>

      <header className="top-bar">
        <span className="title">PortalView</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="cam-count">
            {count === 0 ? 'No cameras' : `${count} camera${count !== 1 ? 's' : ''}`}
          </span>
          <button className="logout-btn" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      <div className="dashboard">

        {/* ── Column 1: Camera feeds ── */}
        <div className="panel panel--cameras">
          <main className="grid">
            {count === 0 ? (
              <div className="empty">
                <p>No cameras connected</p>
                <p className="hint">Waiting for Cameras to connect…</p>
              </div>
            ) : (
              cameras.map((cam) => (
                <CameraFeed
                  key={cam.id}
                  id={cam.id}
                  address={cam.address}
                  name={cam.name}
                  recording={cam.recording}
                  manualRecord={cam.manualRecord}
                  fps={cam.fps}
                  recStartedAt={cam.recStartedAt}
                  battery={cam.battery}
                  connected={cam.connected}
                  sleepEnabled={cam.sleepEnabled}
                  frameSize={cam.frameSize}
                  onExpand={() => cam.connected && setExpanded(cam.id)}
                />
              ))
            )}
          </main>
        </div>

        {/* ── Column 2: Recordings ── */}
        <div className="panel panel--recordings">
          <RecordingsManager
            inline
            cameraNames={Object.fromEntries(cameras.map(c => [c.id, c.name]))}
            uiScale={uiScale}
          />
        </div>

        {/* ── Column 3: Settings ── */}
        <div className="panel panel--settings">
          <Settings inline uiScale={uiScale} onScaleChange={handleScaleChange} />
        </div>

      </div>

      {expanded && expandedCam && (() => {
        const FRAME_SIZES = {
          SXGA: { w: 1280, h: 1024 },
          UXGA: { w: 1600, h: 1200 },
          FHD:  { w: 1920, h: 1080 },
          QXGA: { w: 2048, h: 1536 },
        };
        const fs = FRAME_SIZES[expandedCam.frameSize] ?? FRAME_SIZES.QXGA;
        const ratio = fs.w / fs.h;
        // Fit within 90vw × 90vh preserving aspect ratio
        const overlayStyle = {
          width:  `min(90vw, calc(90vh * ${ratio}))`,
          height: `min(90vh, calc(90vw / ${ratio}))`,
        };
        return (
          <div className="overlay" style={{ zoom: 1 / uiScale }} onClick={() => setExpanded(null)}>
            <button
              className="overlay-close"
              onClick={(e) => { e.stopPropagation(); setExpanded(null); }}
              aria-label="Close"
            >
              ✕
            </button>
            <div className="overlay-window" style={overlayStyle}>
              <OverlayViewer id={expandedCam.id} />
            </div>
            <div className="overlay-label">{expandedCam.name || expandedCam.id}</div>
          </div>
        );
      })()}

      {serverDown && (
        <div className="server-down-overlay" style={{ zoom: 1 / uiScale }}>
          <div className="server-down-overlay__box">
            <div className="server-down-overlay__icon">⚠</div>
            <div className="server-down-overlay__title">Server unreachable</div>
            <div className="server-down-overlay__sub">Reconnecting…</div>
          </div>
        </div>
      )}

      {bell && (
        <div className="bell-banner" style={{ zoom: 1 / uiScale }} onClick={() => setBell(null)}>
          <span className="bell-banner__icon">🔔</span>
          <span className="bell-banner__text">
            <strong>{bell.name || bell.id}</strong> — doorbell pressed
          </span>
          <button className="bell-banner__close" onClick={() => setBell(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

    </div>
  );
}

