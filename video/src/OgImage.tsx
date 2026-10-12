import React from 'react'
import { AbsoluteFill, Img, staticFile } from 'remotion'

/** The 1200×630 social card for collective.email (og:image / twitter:image). */
const BLUE = '#1a6bf0'
const INK = '#141414'
const SANS = 'Inter, sans-serif'
const MONO = '"JetBrains Mono", monospace'

const PH = 548
const PW = PH * 1170 / 2532

export const OgImage: React.FC = () => (
  <AbsoluteFill style={{ background: '#f6f6f3', overflow: 'hidden', fontFamily: SANS }}>
    <div style={{ position: 'absolute', right: -220, top: -160, width: 900, height: 900, borderRadius: 450,
      background: 'radial-gradient(circle, rgba(26,107,240,.16), rgba(26,107,240,0) 65%)' }} />
    {/* the web inbox, behind */}
    <div style={{ position: 'absolute', left: 560, top: 92, width: 880, height: 550, borderRadius: 16, overflow: 'hidden', background: '#fff',
      border: '1px solid #e4e4df', boxShadow: '0 24px 60px rgba(20,20,20,.14)' }}>
      <div style={{ height: 28, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderBottom: '1px solid #e4e4df', background: '#fbfbf9' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 9, height: 9, borderRadius: 5, background: c }} />)}
      </div>
      <Img src={staticFile('shots/inbox.png')} style={{ width: 880, display: 'block' }} />
    </div>
    {/* the notification on a phone, in front */}
    <div style={{ position: 'absolute', left: 900, top: 52, width: PW + 20, height: PH + 20, borderRadius: 50, background: '#111', padding: 10,
      boxShadow: '0 30px 70px rgba(20,20,20,.3), inset 0 0 0 2px #333' }}>
      <div style={{ position: 'relative', width: PW, height: PH, borderRadius: 40, overflow: 'hidden', background: '#fff' }}>
        <Img src={staticFile('shots/ios-after.png')} style={{ width: PW, height: PH }} />
        <div style={{ position: 'absolute', top: 8, left: '50%', marginLeft: -40, width: 80, height: 24, borderRadius: 14, background: '#000' }} />
      </div>
    </div>
    {/* words */}
    <div style={{ position: 'absolute', left: 72, top: 70, width: 560 }}>
      <div style={{ fontFamily: MONO, fontSize: 34, fontWeight: 500, color: INK, letterSpacing: '-0.02em' }}>
        collective<span style={{ color: BLUE }}>.email</span>
      </div>
    </div>
    <div style={{ position: 'absolute', left: 72, top: 200, width: 520 }}>
      <div style={{ fontSize: 66, fontWeight: 800, color: INK, letterSpacing: '-0.035em', lineHeight: 1.04 }}>
        One inbox for your <span style={{ color: BLUE }}>collective</span>
      </div>
      <div style={{ marginTop: 34, display: 'inline-flex', background: '#fff', border: '1px solid #e4e4df', borderRadius: 999, padding: '14px 22px',
        fontFamily: MONO, fontSize: 21, color: INK, boxShadow: '0 8px 24px rgba(20,20,20,.08)' }}>
        yourcollective<span style={{ color: BLUE }}>@collective.email</span>
      </div>
    </div>
  </AbsoluteFill>
)
