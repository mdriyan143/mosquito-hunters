'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Engine } from '../lib/engine';
import { getStats, getTopScores, submitScore } from '../lib/api';

const NAME_KEY = 'hit-machar:name';
const ID_KEY = 'hit-machar:id';
const SKIP_KEY = 'hit-machar:skip-name';

// same rules as the server: letters, numbers, space _ . - (max 16)
const cleanName = (v) => String(v || '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function Game() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [screen, setScreen] = useState('menu'); // menu | settings | play | paused | ranking
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const [ready, setReady] = useState(false);
  const [kills, setKills] = useState(0);
  const [muted, setMuted] = useState(false);
  const [me, setMe] = useState(null); // my best + global rank (shown on the home screen)
  const [full, setFull] = useState({ scores: [], me: null, loading: false, error: '' });
  const [stats, setStats] = useState(null);
  const [snap, setSnap] = useState({ kills: 0, seconds: 0 });
  const [save, setSave] = useState({ state: 'idle', msg: '' });

  // ---- optional global-ranking identity ----
  const [name, setName] = useState(''); // '' = guest (not on the global ranking)
  const nameRef = useRef('');
  const clientIdRef = useRef('');
  const skippedRef = useRef(false);
  const lastSavedRef = useRef(0);
  const [askName, setAskName] = useState(null); // null | 'play' | 'edit'
  const [draft, setDraft] = useState('');
  const [nameErr, setNameErr] = useState('');

  const refreshBoard = useCallback(() => {
    getTopScores(1, clientIdRef.current).then((d) => setMe(d.me || null)).catch(() => {});
    getStats().then(setStats).catch(() => {});
  }, []);

  const loadFull = useCallback(() => {
    setFull((f) => ({ ...f, loading: true, error: '' }));
    getTopScores(50, clientIdRef.current)
      .then((d) => setFull({ scores: d.scores || [], me: d.me || null, loading: false, error: '' }))
      .catch((err) => setFull((f) => ({ ...f, loading: false, error: err.message || 'Could not load ranking' })));
  }, []);

  // ---- engine lifecycle ----
  useEffect(() => {
    // anonymous player id (lets us keep one best score per player; never shown)
    try {
      let id = localStorage.getItem(ID_KEY);
      if (!id) {
        id = newId();
        localStorage.setItem(ID_KEY, id);
      }
      clientIdRef.current = id;
      const saved = cleanName(localStorage.getItem(NAME_KEY) || '');
      nameRef.current = saved;
      setName(saved);
      skippedRef.current = localStorage.getItem(SKIP_KEY) === '1';
    } catch (_) {
      clientIdRef.current = clientIdRef.current || newId(); // storage blocked: session-only id
    }

    const engine = new Engine(canvasRef.current, { onKill: (n) => setKills(n) });
    engineRef.current = engine;
    if (new URLSearchParams(window.location.search).has('debug')) window.__hitMachar = engine;
    let alive = true;
    engine.load().then(() => alive && setReady(true));
    refreshBoard();
    return () => {
      alive = false;
      engine.destroy();
      engineRef.current = null;
    };
  }, [refreshBoard]);

  // ---- global ranking submit (only for players who chose a name) ----
  const submitRun = useCallback(
    async (k, s, { force = false } = {}) => {
      const nm = nameRef.current;
      if (!nm || k < 1) return;
      if (!force && k <= lastSavedRef.current) return;
      setSave({ state: 'saving', msg: 'Saving to global ranking…' });
      try {
        const r = await submitScore({ clientId: clientIdRef.current, name: nm, kills: k, seconds: Math.max(1, s) });
        lastSavedRef.current = Math.max(lastSavedRef.current, k);
        setSave({
          state: 'saved',
          msg: r.improved
            ? `🎉 New best! Global rank #${r.rank}`
            : `🌍 Global rank #${r.rank} · your best is ${r.entry.kills}`,
        });
        refreshBoard();
      } catch (err) {
        setSave({ state: 'error', msg: `Could not save to ranking (${err.message})` });
      }
    },
    [refreshBoard]
  );

  // ---- controls ----
  const play = useCallback(async () => {
    const e = engineRef.current;
    if (!e) return;
    setKills(0);
    lastSavedRef.current = 0;
    setSave({ state: 'idle', msg: '' });
    setScreen('play');
    await e.start();
  }, []);

  // first PLAY asks for an (optional) name once; afterwards it just plays
  const onPlayClick = useCallback(() => {
    if (!nameRef.current && !skippedRef.current) {
      setDraft('');
      setNameErr('');
      setAskName('play');
    } else {
      play();
    }
  }, [play]);

  const openNameBox = useCallback(() => {
    setDraft(nameRef.current);
    setNameErr('');
    setAskName('edit');
  }, []);

  const confirmName = useCallback(async () => {
    const clean = cleanName(draft);
    if (clean.length < 2) {
      setNameErr('Use at least 2 letters or numbers');
      return;
    }
    nameRef.current = clean;
    setName(clean);
    skippedRef.current = false;
    try {
      localStorage.setItem(NAME_KEY, clean);
      localStorage.removeItem(SKIP_KEY);
    } catch (_) { /* ignore */ }
    const mode = askName;
    setAskName(null);
    if (mode === 'play') await play();
    else if (screenRef.current === 'paused') submitRun(snap.kills, snap.seconds, { force: true });
    else if (screenRef.current === 'ranking') loadFull();
  }, [draft, askName, play, submitRun, snap, loadFull]);

  const skipName = useCallback(async () => {
    const mode = askName;
    setAskName(null);
    if (mode !== 'play') return; // 'edit' → plain cancel
    skippedRef.current = true;
    try { localStorage.setItem(SKIP_KEY, '1'); } catch (_) { /* ignore */ }
    await play();
  }, [askName, play]);

  const pause = useCallback(() => {
    const e = engineRef.current;
    if (!e || screenRef.current !== 'play') return;
    e.pause();
    const s = { kills: e.kills, seconds: Math.round(e.elapsed) };
    setSnap(s);
    setScreen('paused');
    submitRun(s.kills, s.seconds); // auto-save for named players
  }, [submitRun]);

  const resume = useCallback(async () => {
    const e = engineRef.current;
    if (!e) return;
    setScreen('play');
    await e.resume();
  }, []);

  const toMenu = useCallback(() => {
    engineRef.current?.stop();
    setScreen('menu');
    refreshBoard();
  }, [refreshBoard]);

  const openRanking = useCallback(() => {
    setScreen('ranking');
    loadFull();
  }, [loadFull]);

  const toggleSound = useCallback(() => {
    setMuted((m) => {
      engineRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  // auto-pause when the tab is hidden; Esc / P toggles pause (ignored while typing)
  useEffect(() => {
    const onVis = () => document.hidden && pause();
    const onKey = (ev) => {
      if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
      if (ev.key === 'Escape' || ev.key.toLowerCase() === 'p') {
        if (screenRef.current === 'play') pause();
        else if (screenRef.current === 'paused') resume();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('keydown', onKey);
    };
  }, [pause, resume]);

  const inGame = screen === 'play' || screen === 'paused';

  return (
    <main className="stage">
      <canvas ref={canvasRef} aria-label="Game area" />

      {inGame && (
        <div className="hud">
          <div className="score">
            <b key={kills} className={kills ? 'pop' : ''} data-testid="kills">{kills}</b>
            <span>TOTAL KILLS</span>
          </div>
          <button className="pause" onClick={pause} aria-label="Pause" disabled={screen !== 'play'}>
            <i /><i />
          </button>
        </div>
      )}

      {(screen === 'menu' || screen === 'settings') && (
        <section className="overlay home fade-in">
          <img className="home-logo" src="/sprites/logo.svg" alt="" />
          <h1 className="home-title">Mosquito<br />Hunter</h1>
          {name && (
            <p className="home-profile">
              {[name, me && `best ${me.kills}`, me && `rank #${me.rank}`].filter(Boolean).join(' · ')}
            </p>
          )}

          {screen === 'settings' ? (
            <div className="home-actions">
              <h2>Settings</h2>
              <button className="hbtn" aria-pressed={!muted} onClick={toggleSound}>Sound: {muted ? 'Off' : 'On'}</button>
              <button className="hbtn" onClick={openNameBox}>{name ? `Name: ${name} · change` : 'Add a name for the ranking'}</button>
              <p className="home-hint">Press and hold to aim. Release to fire.</p>
              <button className="hbtn" onClick={() => setScreen('menu')}>Back</button>
            </div>
          ) : (
            <div className="home-actions">
              <button className="hbtn primary" onClick={onPlayClick} disabled={!ready}>Play</button>
              <button className="hbtn" onClick={openRanking}>Global Ranking</button>
              <button className="hbtn" onClick={() => setScreen('settings')}>Settings</button>
              <button className="hbtn" aria-pressed={!muted} onClick={toggleSound}>Sound: {muted ? 'Off' : 'On'}</button>
            </div>
          )}
        </section>
      )}

      {screen === 'ranking' && (
        <section className="overlay menu fade-in">
          <h2 className="rank-title">🌍 Global Ranking</h2>
          <p className="subtitle">Most mosquitoes killed</p>
          <div className="stack">
            {full.me ? (
              <div className="me-card">
                You: <b>#{full.me.rank}</b> · {full.me.kills} kills as <b>{full.me.name}</b>
              </div>
            ) : (
              <button className="btn primary" onClick={openNameBox}>
                {name ? '✏️ Change my name' : '🏆 Add my name & join'}
              </button>
            )}
            <div className="board">
              {full.loading && <small>Loading…</small>}
              {full.error && <div className="msg err">Could not load ranking ({full.error})</div>}
              {!full.loading && !full.error && full.scores.length === 0 && (
                <small>No one is on the board yet — be the first!</small>
              )}
              <ol>
                {full.scores.map((s) => (
                  <li key={s.rank} className={s.isMe ? 'me' : ''}>
                    <span className="n">{s.rank}</span>
                    <span className="nm">{s.name}</span>
                    <span className="k">{s.kills}</span>
                  </li>
                ))}
              </ol>
              {stats && stats.players > 0 && (
                <small>{stats.totalKills.toLocaleString()} mosquitoes swatted by {stats.players.toLocaleString()} ranked players</small>
              )}
            </div>
            <button className="btn" onClick={() => { setScreen('menu'); refreshBoard(); }}>← Back</button>
          </div>
        </section>
      )}

      {screen === 'paused' && (
        <section className="overlay paused fade-in">
          <div className="card">
            <h2>Paused</h2>
            <div className="stats">
              <div><b>{snap.kills}</b><span>KILLS</span></div>
              <div><b>{fmtTime(snap.seconds)}</b><span>TIME</span></div>
            </div>
            <button className="btn primary" onClick={resume}>▶ Resume</button>
            <button className="btn" onClick={play}>↻ Restart</button>
            {name ? (
              <div className="ranked">🌍 Ranked as <b>{name}</b> · <button className="link inline" onClick={openNameBox}>change</button></div>
            ) : (
              <button className="btn" onClick={openNameBox}>🏆 Join global ranking</button>
            )}
            <div className={`msg ${save.state === 'error' ? 'err' : save.state === 'saved' ? 'ok' : ''}`} role="status">
              {save.msg}
            </div>
            <button className="btn" onClick={toMenu}>⌂ Main menu</button>
            <button className="btn" onClick={toggleSound}>{muted ? '🔇 Sound off' : '🔊 Sound on'}</button>
          </div>
        </section>
      )}

      {askName && (
        <section className="overlay paused fade-in" style={{ zIndex: 20 }}>
          <div className="card">
            <h2>{askName === 'play' ? 'Join the Ranking?' : 'Your Name'}</h2>
            <p className="note">
              Enter a name to appear on the <b>global leaderboard</b>. It&apos;s totally optional — you can skip and just play.
            </p>
            <input
              value={draft}
              maxLength={16}
              placeholder="Your name"
              aria-label="Your name"
              onChange={(e) => { setDraft(e.target.value); setNameErr(''); }}
              onKeyDown={(e) => e.key === 'Enter' && confirmName()}
            />
            <div className="msg err" role="alert">{nameErr}</div>
            <button className="btn primary" onClick={confirmName}>
              {askName === 'play' ? '🏆 Join & Play' : '💾 Save name'}
            </button>
            <button className="btn" onClick={skipName}>{askName === 'play' ? 'Skip, just play' : 'Cancel'}</button>
          </div>
        </section>
      )}
    </main>
  );
}