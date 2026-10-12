import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { Words } from '../components/Words'
import { Logo, Sfx } from '../components/ui'
import { C, MONO, SANS, bounce, clamp, snap } from '../theme'

/** Dark closing card: the line, the name, the call to action. */
export const Outro: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: C.night, alignItems: 'center', justifyContent: 'center', fontFamily: SANS }}>
      <div style={{
        position: 'absolute', width: 1600, height: 1600, borderRadius: 800,
        background: 'radial-gradient(circle, rgba(26,107,240,.3), rgba(26,107,240,0) 60%)',
        scale: interpolate(frame, [0, 160], [0.8, 1.2], clamp),
      }} />
      <div style={{
        textAlign: 'center',
        translate: interpolate(frame, [44, 62], ['0px 0px', '0px -170px'], { ...clamp, easing: snap }),
        scale: interpolate(frame, [44, 62], [1, 0.7], { ...clamp, easing: snap }),
      }}>
        <Words text="Your collective. *One inbox.*" start={4} size={128} color="#fff" />
      </div>
      <div style={{
        position: 'absolute', top: 560, display: 'flex', flexDirection: 'column', alignItems: 'center',
        opacity: interpolate(frame, [52, 58], [0, 1], clamp),
        scale: interpolate(frame, [52, 70], [0.5, 1], { ...clamp, easing: bounce }),
      }}>
        <Logo size={96} color="#fff" />
      </div>
      <div style={{
        position: 'absolute', top: 730, background: C.blue, color: '#fff', fontSize: 38, fontWeight: 700, padding: '24px 52px', borderRadius: 20,
        boxShadow: '0 24px 60px rgba(26,107,240,.45)',
        opacity: interpolate(frame, [70, 75], [0, 1], clamp),
        scale: interpolate(frame, [70, 88], [0.6, 1], { ...clamp, easing: bounce }) + 0.015 * Math.sin(Math.max(0, frame - 90) / 6),
      }}>
        Claim your address →
      </div>
      <div style={{
        position: 'absolute', top: 880, fontFamily: MONO, fontSize: 24, color: 'rgba(255,255,255,.55)',
        opacity: interpolate(frame, [86, 96], [0, 1], clamp),
      }}>
        open source · github.com/opencollective/email
      </div>
      <Sfx name="ding" from={70} volume={0.35} />
    </AbsoluteFill>
  )
}
