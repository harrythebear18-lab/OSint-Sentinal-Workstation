;; ─────────────────────────────────────────────────────────────────
;; SIMD Kernels — WebAssembly Text source with f32x4 SIMD instructions
;; ─────────────────────────────────────────────────────────────────
;;
;; Compiled to simd-kernels.wasm by scripts/compile-wasm.mjs
;; Loaded at runtime by hal/wasm-loader.ts
;;
;; Kernels:
;;   band_math   — (A - B) / (A + B)  [NDVI, NDWI, NBR]  (f32x4 SIMD)
;;   slope       — Horn's method, returns gradient magnitude (scalar f32)
;;   hillshade   — slope + aspect → shading (scalar f32, no trig in WASM)
;;   box_blur    — 3x3 box filter [anomaly detection] (scalar f32)
;;
;; Trig note: WASM has no sin/cos/atan. For hillshade, we use
;; algebraic identities:
;;   cos(atan(x)) = 1/sqrt(1+x²)
;;   sin(atan(x)) = x/sqrt(1+x²)
;;   cos(az-aspect) = cos_az*cos_aspect + sin_az*sin_aspect
;;   cos(aspect) = -dzdx/r, sin(aspect) = dzdy/r  (r=sqrt(dzdx²+dzdy²))
;; The 4 sun constants (cos_zen, sin_zen, cos_az, sin_az) are
;; precomputed in JS and passed as f32 parameters.
;; ─────────────────────────────────────────────────────────────────

(module
  ;; 16 pages = 1 MB
  (memory (export "memory") 16)

  ;; Helper: pixel byte offset = (y * width + x) * 4
  (func $pixelOff (param $y i32) (param $x i32) (param $w i32) (result i32)
    (i32.mul
      (i32.add (i32.mul (local.get $y) (local.get $w)) (local.get $x))
      (i32.const 4)))

  ;; ── Band math: (A - B) / (A + B) — f32x4 SIMD ──
  (func $band_math (param $count i32) (param $aOff i32) (param $bOff i32) (param $outOff i32)
    (local $i i32)
    (local $a v128)
    (local $b v128)
    (local $diff v128)
    (local $sum v128)
    (local $eps v128)

    (local.set $eps (v128.const f32x4 1.0e-10 1.0e-10 1.0e-10 1.0e-10))
    (local.set $i (i32.const 0))

    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (local.get $count)))

        (local.set $a (v128.load (i32.add (local.get $aOff) (local.get $i))))
        (local.set $b (v128.load (i32.add (local.get $bOff) (local.get $i))))

        (local.set $diff (f32x4.sub (local.get $a) (local.get $b)))
        (local.set $sum (f32x4.add (local.get $a) (local.get $b)))
        (local.set $sum (f32x4.add (local.get $sum) (local.get $eps)))

        (v128.store
          (i32.add (local.get $outOff) (local.get $i))
          (f32x4.div (local.get $diff) (local.get $sum)))

        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $loop)
      )
    )
  )

  ;; ── 3x3 Box blur — scalar f32 ──
  (func $box_blur (param $width i32) (param $height i32) (param $inOff i32) (param $outOff i32)
    (local $x i32)
    (local $y i32)
    (local $off i32)
    (local $outByte i32)
    (local $sum f32)

    (local.set $y (i32.const 0))
    (block $y_break
      (loop $y_loop
        (br_if $y_break (i32.ge_u (local.get $y) (local.get $height)))
        (local.set $x (i32.const 0))
        (block $x_break
          (loop $x_loop
            (br_if $x_break (i32.ge_u (local.get $x) (local.get $width)))

            (local.set $sum (f32.const 0.0))

            ;; Row y-1
            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (local.get $x)
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            ;; Row y
            (local.set $off (call $pixelOff
              (local.get $y)
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            (local.set $off (call $pixelOff
              (local.get $y) (local.get $x) (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            (local.set $off (call $pixelOff
              (local.get $y)
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            ;; Row y+1
            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (local.get $x)
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $sum (f32.add (local.get $sum)
              (f32.load (i32.add (local.get $inOff) (local.get $off)))))

            ;; out = sum / 9
            (local.set $outByte (call $pixelOff (local.get $y) (local.get $x) (local.get $width)))
            (f32.store
              (i32.add (local.get $outOff) (local.get $outByte))
              (f32.div (local.get $sum) (f32.const 9.0)))

            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $x_loop)
          )
        )
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $y_loop)
      )
    )
  )

  ;; ── Slope (Horn's method) — returns gradient magnitude ──
  ;; dz/dx = ((z20 + 2*z21 + z22) - (z00 + 2*z01 + z02)) / (8 * cellSize)
  ;; dz/dy = ((z02 + 2*z12 + z22) - (z00 + 2*z10 + z20)) / (8 * cellSize)
  ;; output = sqrt(dz/dx^2 + dz/dy^2)  [gradient magnitude]
  (func $slope (param $width i32) (param $height i32) (param $inOff i32) (param $outOff i32) (param $cellSize f32)
    (local $x i32)
    (local $y i32)
    (local $off i32)
    (local $outByte i32)
    (local $dzdx f32)
    (local $dzdy f32)
    (local $eightCell f32)
    (local $z00 f32) (local $z01 f32) (local $z02 f32)
    (local $z10 f32) (local $z11 f32) (local $z12 f32)
    (local $z20 f32) (local $z21 f32) (local $z22 f32)

    (local.set $eightCell (f32.mul (f32.const 8.0) (local.get $cellSize)))

    (local.set $y (i32.const 0))
    (block $y_break
      (loop $y_loop
        (br_if $y_break (i32.ge_u (local.get $y) (local.get $height)))
        (local.set $x (i32.const 0))
        (block $x_break
          (loop $x_loop
            (br_if $x_break (i32.ge_u (local.get $x) (local.get $width)))

            ;; Load 3x3 neighborhood
            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z00 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (local.get $x)
              (local.get $width)))
            (local.set $z01 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z02 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (local.get $y)
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z10 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff (local.get $y) (local.get $x) (local.get $width)))
            (local.set $z11 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (local.get $y)
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z12 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z20 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (local.get $x)
              (local.get $width)))
            (local.set $z21 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z22 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            ;; dz/dx
            (local.set $dzdx
              (f32.div
                (f32.sub
                  (f32.add (local.get $z20)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z21)) (local.get $z22)))
                  (f32.add (local.get $z00)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z01)) (local.get $z02))))
                (local.get $eightCell)))

            ;; dz/dy
            (local.set $dzdy
              (f32.div
                (f32.sub
                  (f32.add (local.get $z02)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z12)) (local.get $z22)))
                  (f32.add (local.get $z00)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z10)) (local.get $z20))))
                (local.get $eightCell)))

            ;; output = sqrt(dzdx² + dzdy²)
            (local.set $outByte (call $pixelOff (local.get $y) (local.get $x) (local.get $width)))
            (f32.store
              (i32.add (local.get $outOff) (local.get $outByte))
              (f32.sqrt
                (f32.add
                  (f32.mul (local.get $dzdx) (local.get $dzdx))
                  (f32.mul (local.get $dzdy) (local.get $dzdy)))))

            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $x_loop)
          )
        )
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $y_loop)
      )
    )
  )

  ;; ── Hillshade — scalar f32, no trig in WASM ──
  ;; Uses algebraic identities to avoid sin/cos/atan:
  ;;   r = sqrt(dzdx² + dzdy²)
  ;;   cos_slope = 1 / sqrt(1 + r²)
  ;;   sin_slope = r / sqrt(1 + r²)
  ;;   cos_aspect = -dzdx / r  (if r > 0, else 1)
  ;;   sin_aspect =  dzdy / r  (if r > 0, else 0)
  ;;   cos_az_aspect = cos_az * cos_aspect + sin_az * sin_aspect
  ;;   shade = cos_zen * cos_slope + sin_zen * sin_slope * cos_az_aspect
  ;;
  ;; Sun constants (precomputed in JS):
  ;;   cos_zen, sin_zen — from sun elevation
  ;;   cos_az,  sin_az  — from sun azimuth
  (func $hillshade (param $width i32) (param $height i32) (param $inOff i32) (param $outOff i32)
    (param $cellSize f32)
    (param $cosZen f32) (param $sinZen f32) (param $cosAz f32) (param $sinAz f32)
    (local $x i32)
    (local $y i32)
    (local $off i32)
    (local $outByte i32)
    (local $dzdx f32)
    (local $dzdy f32)
    (local $r f32)
    (local $r2 f32)
    (local $onePlusR2 f32)
    (local $sqrtOnePlusR2 f32)
    (local $cosSlope f32)
    (local $sinSlope f32)
    (local $cosAspect f32)
    (local $sinAspect f32)
    (local $cosAzAspect f32)
    (local $shade f32)
    (local $eightCell f32)
    (local $z00 f32) (local $z01 f32) (local $z02 f32)
    (local $z10 f32) (local $z11 f32) (local $z12 f32)
    (local $z20 f32) (local $z21 f32) (local $z22 f32)

    (local.set $eightCell (f32.mul (f32.const 8.0) (local.get $cellSize)))

    (local.set $y (i32.const 0))
    (block $y_break
      (loop $y_loop
        (br_if $y_break (i32.ge_u (local.get $y) (local.get $height)))
        (local.set $x (i32.const 0))
        (block $x_break
          (loop $x_loop
            (br_if $x_break (i32.ge_u (local.get $x) (local.get $width)))

            ;; Load 3x3 neighborhood
            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z00 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (local.get $x)
              (local.get $width)))
            (local.set $z01 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.sub (local.get $y) (i32.const 1))
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z02 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (local.get $y)
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z10 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff (local.get $y) (local.get $x) (local.get $width)))
            (local.set $z11 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (local.get $y)
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z12 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (i32.sub (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z20 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (local.get $x)
              (local.get $width)))
            (local.set $z21 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            (local.set $off (call $pixelOff
              (i32.add (local.get $y) (i32.const 1))
              (i32.add (local.get $x) (i32.const 1))
              (local.get $width)))
            (local.set $z22 (f32.load (i32.add (local.get $inOff) (local.get $off))))

            ;; dz/dx
            (local.set $dzdx
              (f32.div
                (f32.sub
                  (f32.add (local.get $z20)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z21)) (local.get $z22)))
                  (f32.add (local.get $z00)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z01)) (local.get $z02))))
                (local.get $eightCell)))

            ;; dz/dy
            (local.set $dzdy
              (f32.div
                (f32.sub
                  (f32.add (local.get $z02)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z12)) (local.get $z22)))
                  (f32.add (local.get $z00)
                    (f32.add (f32.mul (f32.const 2.0) (local.get $z10)) (local.get $z20))))
                (local.get $eightCell)))

            ;; r = sqrt(dzdx² + dzdy²)
            (local.set $r2
              (f32.add
                (f32.mul (local.get $dzdx) (local.get $dzdx))
                (f32.mul (local.get $dzdy) (local.get $dzdy))))
            (local.set $r (f32.sqrt (local.get $r2)))

            ;; cos_slope = 1/sqrt(1+r²), sin_slope = r/sqrt(1+r²)
            (local.set $onePlusR2 (f32.add (f32.const 1.0) (local.get $r2)))
            (local.set $sqrtOnePlusR2 (f32.sqrt (local.get $onePlusR2)))
            (local.set $cosSlope (f32.div (f32.const 1.0) (local.get $sqrtOnePlusR2)))
            (local.set $sinSlope (f32.div (local.get $r) (local.get $sqrtOnePlusR2)))

            ;; cos_aspect = -dzdx/r, sin_aspect = dzdy/r (handle r=0)
            (if (f32.gt (local.get $r) (f32.const 1.0e-10))
              (then
                (local.set $cosAspect (f32.div (f32.neg (local.get $dzdx)) (local.get $r)))
                (local.set $sinAspect (f32.div (local.get $dzdy) (local.get $r))))
              (else
                (local.set $cosAspect (f32.const 1.0))
                (local.set $sinAspect (f32.const 0.0))))

            ;; cos_az_aspect = cos_az * cos_aspect + sin_az * sin_aspect
            (local.set $cosAzAspect
              (f32.add
                (f32.mul (local.get $cosAz) (local.get $cosAspect))
                (f32.mul (local.get $sinAz) (local.get $sinAspect))))

            ;; shade = cos_zen * cos_slope + sin_zen * sin_slope * cos_az_aspect
            (local.set $shade
              (f32.add
                (f32.mul (local.get $cosZen) (local.get $cosSlope))
                (f32.mul
                  (f32.mul (local.get $sinZen) (local.get $sinSlope))
                  (local.get $cosAzAspect))))

            ;; Clamp to [0, 1] and scale to [0, 255]
            (if (f32.lt (local.get $shade) (f32.const 0.0))
              (then (local.set $shade (f32.const 0.0))))
            (if (f32.gt (local.get $shade) (f32.const 1.0))
              (then (local.set $shade (f32.const 1.0))))

            (local.set $outByte (call $pixelOff (local.get $y) (local.get $x) (local.get $width)))
            (f32.store
              (i32.add (local.get $outOff) (local.get $outByte))
              (f32.mul (local.get $shade) (f32.const 255.0)))

            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $x_loop)
          )
        )
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $y_loop)
      )
    )
  )

  ;; ── Exports ──
  ;; Note: memory is already exported inline via (memory (export "memory") 16) above.
  (export "band_math" (func $band_math))
  (export "box_blur" (func $box_blur))
  (export "slope" (func $slope))
  (export "hillshade" (func $hillshade))
)
