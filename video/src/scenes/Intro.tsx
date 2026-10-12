import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion'
import { Words } from '../components/Words'
import { Logo, Sfx } from '../components/ui'
import { C, bounce, clamp, snap } from '../theme'

/** Dark opening card: the promise, word by word, then the name. */
export const Intro: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ background: C.night, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        position: 'absolute', width: 1400, height: 1400, borderRadius: 700,
        background: 'radial-gradient(circle, rgba(26,107,240,.28), rgba(26,107,240,0) 60%)',
        scale: interpolate(frame, [0, 110], [0.7, 1.15], clamp),
      }} />
      <div style={{
        textAlign: 'center', maxWidth: 1500,
        translate: interpolate(frame, [52, 70], ['0px 0px', '0px -90px'], { ...clamp, easing: snap }),
        scale: interpolate(frame, [52, 70], [1, 0.82], { ...clamp, easing: snap }),
      }}>
        <Words text="One inbox for your *collective*" start={6} size={150} color="#fff" />
      </div>
      <div style={{
        position: 'absolute', top: 690,
        opacity: interpolate(frame, [58, 64], [0, 1], clamp),
        scale: interpolate(frame, [58, 76], [0.4, 1], { ...clamp, easing: bounce }),
      }}>
        <Logo size={76} color="#fff" />
      </div>
      <Sfx name="switch" from={58} volume={0.45} />
    </AbsoluteFill>
  )
}
