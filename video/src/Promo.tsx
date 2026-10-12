import React from 'react'
import { AbsoluteFill, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'

const C = {
  bg: '#f6f6f3',
  ink: '#141414',
  muted: '#6b7280',
  blue: '#1a6bf0',
  line: '#e4e4df',
}
const SANS = 'Inter, sans-serif'
const MONO = '"JetBrains Mono", monospace'

type Rect = [number, number, number, number] // x, y, w, h as fractions of the image
type Key = { f: number; r: Rect }

const ease = Easing.bezier(0.65, 0, 0.35, 1)
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/** Frame-driven camera over a screenshot: interpolates a focus rectangle
 *  between keyframes and fits it to the viewport. Children are positioned in
 *  the image's natural pixels, so overlays move with the zoom. */
const Camera: React.FC<{ src: string; iw: number; ih: number; w: number; h: number; keys: Key[]; children?: React.ReactNode }> =
  ({ src, iw, ih, w, h, keys, children }) => {
    const frame = useCurrentFrame()
    const fs = keys.map((k) => k.f)
    const r = [0, 1, 2, 3].map((i) => keys.length === 1 ? keys[0].r[i]
      : interpolate(frame, fs, keys.map((k) => k.r[i]), { ...clamp, easing: ease })) as Rect
    const s = Math.min(w / (r[2] * iw), h / (r[3] * ih))
    const tx = w / 2 - (r[0] + r[2] / 2) * iw * s
    const ty = h / 2 - (r[1] + r[3] / 2) * ih * s
    return (
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: C.bg }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: iw, height: ih, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${s})` }}>
          <Img src={staticFile(src)} style={{ width: iw, height: ih, display: 'block' }} />
          {children}
        </div>
      </div>
    )
  }

/** A desktop browser window around a camera. */
const Browser: React.FC<{ url: string; children: React.ReactNode; w?: number; h?: number; enter?: number; top?: number }> = ({ url, children, w = 1312, h = 820, enter = 0, top = 212 }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const p = spring({ frame: frame - enter, fps, config: { damping: 200 } })
  return (
    <div style={{
      position: 'absolute', left: (1920 - w) / 2, top, width: w, height: h, borderRadius: 18, overflow: 'hidden',
      background: '#fff', boxShadow: '0 30px 80px rgba(20,20,20,.16), 0 4px 14px rgba(20,20,20,.08)', border: `1px solid ${C.line}`,
      opacity: p, transform: `translateY(${(1 - p) * 60}px)`,
    }}>
      <div style={{ height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: `1px solid ${C.line}`, background: '#fbfbf9' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />)}
        <div style={{ margin: '0 auto', fontFamily: SANS, fontSize: 15, color: C.muted, background: '#efefeb', borderRadius: 8, padding: '4px 60px' }}>{url}</div>
      </div>
      <div style={{ position: 'absolute', top: 40, left: 0, right: 0, bottom: 0 }}>{children}</div>
    </div>
  )
}
const VIEW_W = 1312
const VIEW_H = 780

/** Headline at the top of a feature scene, word-by-word reveal. */
const Headline: React.FC<{ text: React.ReactNode[]; x?: number; align?: 'center' | 'left'; top?: number; width?: number }> =
  ({ text, x = 0, align = 'center', top = 74, width = 1920 }) => {
    const frame = useCurrentFrame()
    const { fps } = useVideoConfig()
    return (
      <div style={{ position: 'absolute', left: x, top, width, textAlign: align, fontFamily: SANS }}>
        <div style={{ fontSize: 58, fontWeight: 750, color: C.ink, letterSpacing: '-0.025em', lineHeight: 1.08 }}>
          {text.map((t, i) => {
            const p = spring({ frame: frame - 3 - i * 3, fps, config: { damping: 200 } })
            return <span key={i} style={{ display: 'inline-block', opacity: p, transform: `translateY(${(1 - p) * 24}px)`, marginRight: '0.26em' }}>{t}</span>
          })}
        </div>
      </div>
    )
  }
const Blue: React.FC<{ children: React.ReactNode }> = ({ children }) => <span style={{ color: C.blue }}>{children}</span>
const words = (s: string, accent: string[] = []) => s.split(' ').map((w) => accent.includes(w) ? <Blue>{w}</Blue> : w)

/** Fade a whole scene in and out so cuts never feel abrupt. */
const Scene: React.FC<{ dur: number; children: React.ReactNode }> = ({ dur, children }) => {
  const frame = useCurrentFrame()
  const o = interpolate(frame, [0, 8, dur - 10, dur], [0, 1, 1, 0], clamp)
  return <AbsoluteFill style={{ background: C.bg, opacity: o }}>{children}</AbsoluteFill>
}

/** Pulsing ring around a region, in image pixels. */
const Ring: React.FC<{ x: number; y: number; w: number; h: number; from: number; radius?: number }> = ({ x, y, w, h, from, radius = 16 }) => {
  const frame = useCurrentFrame()
  const o = interpolate(frame, [from, from + 8], [0, 1], clamp)
  const pulse = 1 + 0.03 * Math.sin((frame - from) / 5)
  return <div style={{ position: 'absolute', left: x - 10, top: y - 10, width: w + 20, height: h + 20, borderRadius: radius, border: `6px solid ${C.blue}`,
    boxShadow: '0 0 0 10px rgba(26,107,240,.15)', opacity: o, transform: `scale(${pulse})` }} />
}

const Logo: React.FC<{ size: number }> = ({ size }) => (
  <div style={{ fontFamily: MONO, fontSize: size, fontWeight: 500, color: C.ink, letterSpacing: '-0.02em' }}>
    collective<span style={{ color: C.blue }}>.email</span>
  </div>
)

// ---------------- scenes ----------------

const Intro: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const p = spring({ frame, fps, config: { damping: 14, mass: 0.8 } })
  const env = spring({ frame: frame - 4, fps, config: { damping: 12 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div style={{ fontSize: 120, transform: `scale(${env}) rotate(${(1 - env) * -20}deg)`, marginBottom: 26 }}>✉️</div>
      <div style={{ transform: `scale(${0.8 + 0.2 * p})`, opacity: p }}><Logo size={110} /></div>
      <div style={{ fontFamily: SANS, fontSize: 40, color: C.muted, marginTop: 26, opacity: interpolate(frame, [22, 38], [0, 1], clamp),
        transform: `translateY(${interpolate(frame, [22, 38], [20, 0], clamp)}px)` }}>
        One inbox for your collective
      </div>
    </AbsoluteFill>
  )
}

const CLAIM_IW = 2880, CLAIM_IH = 1800
const Claim: React.FC = () => {
  const frame = useCurrentFrame()
  const typed = 'commonshub'.slice(0, Math.max(0, Math.floor((frame - 34) / 3)))
  const caret = Math.floor(frame / 8) % 2 === 0
  const press = interpolate(frame, [78, 82, 88], [1, 0.96, 1], clamp)
  const toast = spring({ frame: frame - 92, fps: 30, config: { damping: 14 } })
  return (
    <>
      <Headline text={words('Creating an email for your collective has never been easier', ['easier'])} />
      <Browser url="collective.email/claim">
        <Camera src="shots/claim.png" iw={CLAIM_IW} ih={CLAIM_IH} w={VIEW_W} h={VIEW_H}
          keys={[{ f: 0, r: [0.08, 0.05, 0.84, 0.9] }, { f: 30, r: [0.22, 0.16, 0.56, 0.62] }, { f: 140, r: [0.25, 0.17, 0.5, 0.56] }]}>
          {/* the empty field, typed into */}
          <div style={{ position: 'absolute', left: 1078, top: 993, width: 380, height: 68, background: '#fff' }} />
          <div style={{ position: 'absolute', left: 1093, top: 1004, fontFamily: MONO, fontSize: 31, color: C.ink, lineHeight: '46px' }}>
            {typed}<span style={{ display: 'inline-block', width: 3, height: 34, background: C.blue, marginLeft: 2, verticalAlign: 'middle', opacity: caret && frame < 80 ? 1 : 0 }} />
          </div>
          <div style={{ position: 'absolute', left: 1066, top: 1183, width: 748, height: 87, borderRadius: 14, transform: `scale(${press})`,
            boxShadow: frame > 78 && frame < 92 ? '0 0 0 10px rgba(26,107,240,.25)' : 'none' }} />
        </Camera>
      </Browser>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 952, display: 'flex', justifyContent: 'center', opacity: toast, transform: `translateY(${(1 - toast) * 40}px)` }}>
        <div style={{ background: C.ink, color: '#fff', fontFamily: SANS, fontSize: 30, fontWeight: 600, padding: '20px 34px', borderRadius: 16, boxShadow: '0 20px 50px rgba(0,0,0,.25)' }}>
          <span style={{ fontFamily: MONO, fontWeight: 500 }}>commonshub@collective.email</span> is live 🎉
        </div>
      </div>
    </>
  )
}

const DESK_IW = 2880, DESK_IH = 1800
const FULL: Rect = [0, 0, 1, 0.951]
const Share: React.FC = () => {
  const frame = useCurrentFrame()
  const swap = interpolate(frame, [78, 92], [0, 1], clamp)
  return (
    <>
      <Headline text={words('Share the inbox with the members of your collective', ['members'])} />
      <Browser url="collective.email/inbox/commonshub/members">
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - swap }}>
          <Camera src="shots/members.png" iw={DESK_IW} ih={DESK_IH} w={VIEW_W} h={VIEW_H}
            keys={[{ f: 0, r: FULL }, { f: 25, r: FULL }, { f: 80, r: [0.2, 0.1, 0.8, 0.7] }]}>
            <Ring x={648} y={291} w={2183} h={1074} from={30} radius={24} />
          </Camera>
        </div>
        <div style={{ position: 'absolute', inset: 0, opacity: swap }}>
          <Camera src="shots/inbox.png" iw={DESK_IW} ih={DESK_IH} w={VIEW_W} h={VIEW_H}
            keys={[{ f: 80, r: FULL }, { f: 150, r: [0.02, 0, 0.98, 0.93] }]} />
        </div>
      </Browser>
    </>
  )
}

/** iPhone frame around a full-screen screenshot (1170×2532). */
const PHONE_W = 418, PHONE_H = PHONE_W * 2532 / 1170
const Phone: React.FC<{ x: number; y: number; children: React.ReactNode }> = ({ x, y, children }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: PHONE_W + 28, height: PHONE_H + 28, borderRadius: 72, background: '#111', padding: 14,
    boxShadow: '0 40px 90px rgba(20,20,20,.28), inset 0 0 0 2px #333' }}>
    <div style={{ position: 'relative', width: PHONE_W, height: PHONE_H, borderRadius: 58, overflow: 'hidden', background: '#fff' }}>
      {children}
      <div style={{ position: 'absolute', top: 11, left: '50%', marginLeft: -62, width: 124, height: 36, borderRadius: 20, background: '#000' }} />
    </div>
  </div>
)

/** The assignment badge, cropped from an iPhone capture (1170 px wide). */
const Badge: React.FC<{ src: string; w: number }> = ({ src, w }) => {
  const k = 0.82
  return (
    <div style={{ width: w, height: 112 * k, overflow: 'hidden', position: 'relative', borderRadius: 14, background: '#fff', boxShadow: '0 12px 30px rgba(20,20,20,.12)' }}>
      <Img src={staticFile(src)} style={{ position: 'absolute', width: 1170 * k, left: -(48 - 14) * k, top: -(852 - 11) * k }} />
    </div>
  )
}

const Assign: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = spring({ frame: frame - 4, fps, config: { damping: 200 } })
  const tapAt = 70
  const swap = interpolate(frame, [tapAt + 10, tapAt + 22], [0, 1], clamp)
  // the "Assign to me" button, from the capture's measured box
  const bx = (0.041 + 0.499 / 2) * PHONE_W, by = (0.75 + 0.032 / 2) * PHONE_H
  const finger = interpolate(frame, [tapAt - 30, tapAt - 4], [0, 1], { ...clamp, easing: ease })
  const ripple = interpolate(frame, [tapAt, tapAt + 18], [0, 1], clamp)
  const zoom = interpolate(frame, [tapAt + 34, tapAt + 56], [0, 1], { ...clamp, easing: ease })
  return (
    <>
      <Headline align="left" x={150} top={390} width={760}
        text={words('Assign any thread to anyone in one tap', ['one', 'tap'])} />
      <div style={{ position: 'absolute', left: 150, top: 580, display: 'flex', alignItems: 'center', gap: 26, opacity: zoom, transform: `translateY(${(1 - zoom) * 30}px)` }}>
        <Badge src="shots/ios-before.png" w={282} />
        <span style={{ fontFamily: SANS, fontSize: 40, color: C.muted }}>→</span>
        <Badge src="shots/ios-after.png" w={412} />
      </div>
      <div style={{ opacity: enter, transform: `translateY(${(1 - enter) * 80}px)` }}>
        <Phone x={1130} y={56}>
          <div style={{ position: 'absolute', inset: 0 }}>
            <Img src={staticFile('shots/ios-before.png')} style={{ position: 'absolute', width: PHONE_W, height: PHONE_H }} />
            <Img src={staticFile('shots/ios-after.png')} style={{ position: 'absolute', width: PHONE_W, height: PHONE_H, opacity: swap }} />
            <div style={{ position: 'absolute', left: bx - 60, top: by - 60, width: 120, height: 120, borderRadius: 60, background: 'rgba(26,107,240,.35)',
              transform: `scale(${ripple * 1.4})`, opacity: ripple > 0 ? 1 - ripple : 0 }} />
            <div style={{ position: 'absolute', left: 0.033 * PHONE_W, top: 0.3365 * PHONE_H - 5, width: 0.42 * PHONE_W, height: 0.0355 * PHONE_H + 10, borderRadius: 10,
              border: `3px solid ${C.blue}`, opacity: zoom }} />
          </div>
        </Phone>
      </div>
      {/* the finger */}
      <div style={{ position: 'absolute', left: 1144 + bx - 26 + (1 - finger) * 260, top: 70 + by - 10 + (1 - finger) * 220,
        width: 52, height: 52, borderRadius: 26, background: 'rgba(20,20,20,.28)', border: '3px solid rgba(255,255,255,.9)',
        opacity: interpolate(frame, [tapAt - 30, tapAt - 20, tapAt + 14, tapAt + 24], [0, 1, 1, 0], clamp),
        transform: `scale(${frame >= tapAt && frame < tapAt + 8 ? 0.82 : 1})` }} />
    </>
  )
}

const THREAD_IW = 2880, THREAD_IH = 4600
const Notes: React.FC = () => (
  <>
    <Headline text={words('Add internal notes', ['internal'])} />
    <Browser url="collective.email/inbox/commonshub/thread/1" enter={0}>
      <Camera src="shots/thread-full.png" iw={THREAD_IW} ih={THREAD_IH} w={VIEW_W} h={VIEW_H}
        keys={[{ f: 0, r: [0.2, 0.06, 0.62, 0.22] }, { f: 30, r: [0.2, 0.06, 0.62, 0.22] }, { f: 75, r: [0.21, 0.2, 0.47, 0.128] }]}>
        <Ring x={780} y={1080} w={1100} h={330} from={80} />
      </Camera>
    </Browser>
  </>
)

const Agents: React.FC = () => {
  const frame = useCurrentFrame()
  const swap = interpolate(frame, [70, 84], [0, 1], clamp)
  return (
    <>
      <Headline text={words('Add agents as members of your collective', ['agents'])} />
      <Browser url="collective.email/inbox/commonshub">
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - swap }}>
          <Camera src="shots/members.png" iw={DESK_IW} ih={DESK_IH} w={VIEW_W} h={VIEW_H}
            keys={[{ f: 0, r: [0.2, 0.12, 0.8, 0.5] }, { f: 30, r: [0.22, 0.3, 0.6, 0.3] }]}>
            <Ring x={693} y={642} w={2090} h={95} from={30} radius={18} />
          </Camera>
        </div>
        <div style={{ position: 'absolute', inset: 0, opacity: swap }}>
          <Camera src="shots/thread-full.png" iw={THREAD_IW} ih={THREAD_IH} w={VIEW_W} h={VIEW_H}
            keys={[{ f: 70, r: [0.21, 0.2, 0.62, 0.17] }, { f: 120, r: [0.21, 0.315, 0.62, 0.15] }]}>
            <Ring x={648} y={1492} w={1665} h={622} from={110} />
          </Camera>
        </div>
      </Browser>
    </>
  )
}

const Drafts: React.FC = () => {
  const frame = useCurrentFrame()
  const swap = interpolate(frame, [60, 74], [0, 1], clamp)
  return (
    <>
      <Headline text={words('Prepare drafts together', ['drafts'])} />
      <Browser url="collective.email/inbox/commonshub?f=drafts">
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - swap }}>
          <Camera src="shots/drafts.png" iw={DESK_IW} ih={DESK_IH} w={VIEW_W} h={VIEW_H}
            keys={[{ f: 0, r: [0, 0, 1, 0.57] }, { f: 60, r: [0.15, 0, 0.85, 0.48] }]} />
        </div>
        <div style={{ position: 'absolute', inset: 0, opacity: swap }}>
          <Camera src="shots/draft-nl.png" iw={DESK_IW} ih={DESK_IH} w={VIEW_W} h={VIEW_H}
            keys={[{ f: 60, r: [0.15, 0, 0.85, 0.75] }, { f: 140, r: [0.21, 0.02, 0.66, 0.58] }]}>
            <Ring x={652} y={344} w={1655} h={180} from={100} />
          </Camera>
        </div>
      </Browser>
    </>
  )
}

const Outro: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const p = spring({ frame, fps, config: { damping: 200 } })
  const b = spring({ frame: frame - 18, fps, config: { damping: 12 } })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', fontFamily: SANS }}>
      <div style={{ opacity: p, transform: `translateY(${(1 - p) * 30}px)` }}><Logo size={96} /></div>
      <div style={{ marginTop: 56, transform: `scale(${b})`, background: C.blue, color: '#fff', fontSize: 34, fontWeight: 650, padding: '22px 46px', borderRadius: 18,
        boxShadow: '0 20px 50px rgba(26,107,240,.35)' }}>
        Claim your address at collective.email →
      </div>
    </AbsoluteFill>
  )
}

const SCENES: [React.FC, number][] = [
  [Intro, 84],
  [Claim, 150],
  [Share, 160],
  [Assign, 200],
  [Notes, 140],
  [Agents, 160],
  [Drafts, 160],
  [Outro, 130],
]
export const PROMO_FRAMES = SCENES.reduce((a, [, d]) => a + d, 0)

export const Promo: React.FC = () => {
  let at = 0
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {SCENES.map(([S, d], i) => {
        const from = at
        at += d
        return <Sequence key={i} from={from} durationInFrames={d}><Scene dur={d}><S /></Scene></Sequence>
      })}
    </AbsoluteFill>
  )
}
