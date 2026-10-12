import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { Browser, Camera, DESK, Feature, Sfx, VIEW_H, VIEW_W, featureUiAt } from '../components/ui'
import { C, MONO, SANS, bounce, clamp } from '../theme'

const TITLE = 'Creating an email for your collective has never been *easier*'

export const Claim: React.FC = () => {
  const frame = useCurrentFrame()
  const U = featureUiAt(TITLE)
  const typeAt = U + 14
  const pressAt = U + 50
  const typed = 'commonshub'.slice(0, Math.max(0, Math.floor((frame - typeAt) / 3)))
  return (
    <Feature title={TITLE}>
      <Browser url="collective.email/claim">
        <Camera src="shots/claim.png" {...DESK} w={VIEW_W} h={VIEW_H}
          keys={[{ f: U - 30, r: [0.08, 0.05, 0.84, 0.9] }, { f: U + 12, r: [0.22, 0.16, 0.56, 0.62] }, { f: U + 110, r: [0.25, 0.17, 0.5, 0.56] }]}>
          {/* the empty field, typed into */}
          <div style={{ position: 'absolute', left: 1078, top: 993, width: 380, height: 68, background: '#fff' }} />
          <div style={{ position: 'absolute', left: 1093, top: 1004, fontFamily: MONO, fontSize: 31, color: C.ink, lineHeight: '46px' }}>
            {typed}
            <span style={{
              display: 'inline-block', width: 3, height: 34, background: C.blue, marginLeft: 2, verticalAlign: 'middle',
              opacity: Math.floor(frame / 8) % 2 === 0 && frame < pressAt ? 1 : 0,
            }} />
          </div>
          <div style={{
            position: 'absolute', left: 1066, top: 1183, width: 748, height: 87, borderRadius: 14,
            scale: interpolate(frame, [pressAt, pressAt + 4, pressAt + 10], [1, 0.95, 1], clamp),
            boxShadow: `0 0 0 ${interpolate(frame, [pressAt, pressAt + 14], [0, 26], clamp)}px rgba(26,107,240,${interpolate(frame, [pressAt, pressAt + 14], [0.4, 0], clamp)})`,
          }} />
        </Camera>
      </Browser>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 930, display: 'flex', justifyContent: 'center',
        opacity: interpolate(frame, [pressAt + 12, pressAt + 16], [0, 1], clamp),
        scale: interpolate(frame, [pressAt + 12, pressAt + 30], [0.5, 1], { ...clamp, easing: bounce }),
      }}>
        <div style={{
          background: C.ink, color: '#fff', fontFamily: SANS, fontSize: 36, fontWeight: 650, padding: '24px 40px', borderRadius: 18,
          boxShadow: '0 24px 60px rgba(0,0,0,.3)',
        }}>
          <span style={{ fontFamily: MONO, fontWeight: 500 }}>commonshub<span style={{ color: '#7fb0ff' }}>@collective.email</span></span> is live 🎉
        </div>
      </div>
      <Sfx name="mouse-click" from={pressAt} volume={0.6} />
      <Sfx name="ding" from={pressAt + 12} volume={0.3} />
    </Feature>
  )
}
