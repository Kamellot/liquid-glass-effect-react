import { createContext, useCallback, useLayoutEffect, useState, type HTMLAttributes, type RefObject } from 'react'
import { SceneHandle } from './scene'

export const SceneContext = createContext<SceneHandle | null>(null)

interface GlassSceneProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional access to the underlying element. */
  elRef?: RefObject<HTMLDivElement | null>
}

/**
 * Marks a region whose contents glass may refract on engines that cannot read the
 * live backdrop (Safari / iOS). The subtree is mirrored into a texture on layout /
 * content changes. On Chromium (SVG backdrop-filter) it is a plain <div>.
 *
 * `<LiquidGlass />` instances rendered inside pick the nearest scene automatically.
 * Mark anything that sits *above* the glass (icons, buttons) with `data-glass-ignore`
 * so it isn't baked into the refracted texture twice.
 */
export function GlassScene({ elRef, children, ...rest }: GlassSceneProps) {
  const [scene] = useState(() => new SceneHandle())
  const [el, setEl] = useState<HTMLDivElement | null>(null)

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setEl(node)
      if (elRef) elRef.current = node
    },
    [elRef],
  )

  useLayoutEffect(() => {
    if (!el) return
    scene.attach(el)
    return () => scene.detach()
  }, [scene, el])

  return (
    <SceneContext.Provider value={scene}>
      <div ref={ref} data-glass-scene="" {...rest}>
        {children}
      </div>
    </SceneContext.Provider>
  )
}

