import React from 'react'
import { Browser, Camera, DESK, FULL, Feature, Ring, Swap, VIEW_H, VIEW_W, featureUiAt } from '../components/ui'

const TITLE = 'Share the inbox with the members of your *collective*'

export const Share: React.FC = () => {
  const U = featureUiAt(TITLE)
  return (
    <Feature title={TITLE}>
      <Browser url="collective.email/inbox/commonshub/members">
        <Swap at={U + 58}
          a={
            <Camera src="shots/members.png" {...DESK} w={VIEW_W} h={VIEW_H}
              keys={[{ f: U, r: FULL }, { f: U + 16, r: FULL }, { f: U + 55, r: [0.2, 0.1, 0.8, 0.7] }]}>
              <Ring x={648} y={291} w={2183} h={1074} from={U + 18} radius={24} />
            </Camera>
          }
          b={<Camera src="shots/inbox.png" {...DESK} w={VIEW_W} h={VIEW_H} keys={[{ f: U + 58, r: FULL }, { f: U + 120, r: [0.02, 0, 0.98, 0.93] }]} />}
        />
      </Browser>
    </Feature>
  )
}
