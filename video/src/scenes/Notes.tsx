import React from 'react'
import { Browser, Camera, Feature, Ring, THREAD, VIEW_H, VIEW_W, featureUiAt } from '../components/ui'

const TITLE = 'Add *internal notes*'

export const Notes: React.FC = () => {
  const U = featureUiAt(TITLE)
  return (
    <Feature title={TITLE}>
      <Browser url="collective.email/inbox/commonshub/thread/1">
        <Camera src="shots/thread-full.png" {...THREAD} w={VIEW_W} h={VIEW_H}
          keys={[{ f: U, r: [0.2, 0.06, 0.62, 0.22] }, { f: U + 12, r: [0.2, 0.06, 0.62, 0.22] }, { f: U + 50, r: [0.21, 0.2, 0.47, 0.128] }]}>
          <Ring x={780} y={1080} w={1100} h={330} from={U + 52} />
        </Camera>
      </Browser>
    </Feature>
  )
}
