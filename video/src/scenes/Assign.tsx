import React from 'react'
import { CanvasImage, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { Feature, PHONE_H, PHONE_W, Phone, Sfx, featureUiAt } from '../components/ui'
import { C, SANS, clamp, glide, snap } from '../theme'

const TITLE = 'Assign any thread to anyone in *one tap*'
const PHONE_X = 1130
const PHONE_Y = 56

/** The assignment badge, cropped from the iPhone capture (1170 px wide). */
const Badge: React.FC<{ src: string; w: number }> = ({ src, w }) => {
  const { fps } = useVideoConfig()
  const k = 0.82
  return (
    <div style={{ width: w, height: 112 * k, overflow: 'hidden', position: 'relative', borderRadius: 14, background: '#fff', boxShadow: '0 14px 34px rgba(20,20,20,.14)' }}>
      <CanvasImage src={staticFile(src)} width={1170} height={2532} premountFor={fps}
        style={{ position: 'absolute', width: 1170 * k, height: 2532 * k, left: -(48 - 14) * k, top: -(852 - 11) * k }} />
    </div>
  )
}

export const Assign: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const U = featureUiAt(TITLE)
  const tapAt = U + 40
  const proofAt = tapAt + 30
  // the "Assign to me" button, from the capture's measured box (ios-boxes.json)
  const bx = (0.041 + 0.499 / 2) * PHONE_W
  const by = (0.75 + 0.032 / 2) * PHONE_H
  const screen = { position: 'absolute', width: PHONE_W, height: PHONE_H } as const
  return (
    <Feature title={TITLE} layout="left">
      <div style={{
        position: 'absolute', left: 150, width: 820, top: 590, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 26,
        opacity: interpolate(frame, [proofAt, proofAt + 8], [0, 1], clamp),
        translate: interpolate(frame, [proofAt, proofAt + 16], ['0px 40px', '0px 0px'], { ...clamp, easing: snap }),
      }}>
        <Badge src="shots/ios-before.png" w={282} />
        <span style={{ fontFamily: SANS, fontSize: 44, fontWeight: 700, color: C.blue }}>→</span>
        <Badge src="shots/ios-after.png" w={412} />
      </div>
      <Phone style={{ left: PHONE_X, top: PHONE_Y }}>
        <CanvasImage src={staticFile('shots/ios-before.png')} width={1170} height={2532} premountFor={fps} style={screen} />
        <CanvasImage src={staticFile('shots/ios-after.png')} width={1170} height={2532} premountFor={fps}
          style={{ ...screen, opacity: interpolate(frame, [tapAt + 10, tapAt + 20], [0, 1], clamp) }} />
        <div style={{
          position: 'absolute', left: bx - 60, top: by - 60, width: 120, height: 120, borderRadius: 60, background: 'rgba(26,107,240,.4)',
          scale: interpolate(frame, [tapAt, tapAt + 18], [0, 1.6], clamp),
          opacity: interpolate(frame, [tapAt, tapAt + 1, tapAt + 18], [0, 1, 0], clamp),
        }} />
        {/* the badge that just changed */}
        <div style={{
          position: 'absolute', left: 0.033 * PHONE_W, top: 0.3365 * PHONE_H - 5, width: 0.42 * PHONE_W, height: 0.0355 * PHONE_H + 10, borderRadius: 10,
          border: `3px solid ${C.blue}`, boxShadow: '0 0 0 6px rgba(26,107,240,.18)',
          opacity: interpolate(frame, [tapAt + 22, tapAt + 28], [0, 1], clamp),
        }} />
      </Phone>
      {/* the finger */}
      <div style={{
        position: 'absolute', left: PHONE_X + 14 + bx - 26, top: PHONE_Y + 14 + by - 26, width: 52, height: 52, borderRadius: 26,
        background: 'rgba(20,20,20,.28)', border: '3px solid rgba(255,255,255,.9)',
        translate: interpolate(frame, [tapAt - 26, tapAt - 3], ['260px 220px', '0px 0px'], { ...clamp, easing: glide }),
        opacity: interpolate(frame, [tapAt - 26, tapAt - 18, tapAt + 12, tapAt + 22], [0, 1, 1, 0], clamp),
        scale: interpolate(frame, [tapAt - 1, tapAt + 2, tapAt + 8], [1, 0.8, 1], clamp),
      }} />
      <Sfx name="mouse-click" from={tapAt} volume={0.6} />
      <Sfx name="switch" from={tapAt + 12} volume={0.35} />
    </Feature>
  )
}
