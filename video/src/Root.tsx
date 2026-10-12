import { Composition } from 'remotion'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import { Promo, PROMO_FRAMES } from './Promo'
import { OgImage } from './OgImage'

export const Root = () => (
  <>
    <Composition id="Promo" component={Promo} durationInFrames={PROMO_FRAMES} fps={30} width={1920} height={1080} />
    <Composition id="OgImage" component={OgImage} durationInFrames={1} fps={30} width={1200} height={630} />
  </>
)
