/**
 * STAC / COG Service — real Sentinel-2 ingestion.
 *
 * Searches the public Element84 Earth Search STAC API for Sentinel-2 L2A
 * scenes covering a geographic and temporal bbox, selects the least-cloudy
 * scene, and reads real Cloud-Optimized GeoTIFF (COG) band assets using
 * `geotiff`. Computes NDVI, NDWI, or NBR from the actual band values and
 * returns a Float32Array + WGS84 bounding box for overlay in Cesium.
 *
 * This replaces the GIBS browse imagery approach with actual Sentinel-2
 * Level-2A reflectance data.
 *
 * Data source: https://earth-search.aws.element84.com/v1/ (keyless)
 * Collection: sentinel-2-l2a
 *
 * Band math:
 *   NDVI = (B08 - B04) / (B08 + B04)
 *   NDWI = (B03 - B08) / (B03 + B08)
 *   NBR  = (B08 - B11) / (B08 + B11)
 *
 * Sentinel-2 L2A reflectance is stored as 16-bit unsigned integers where
 * DN = reflectance * 10000 (approx). We convert to reflectance by dividing
 * by 10000 before computing band math.
 */

import { fromUrl, type GeoTIFFImage } from 'geotiff'
import proj4 from 'proj4'

export interface StacSearchOptions {
  west: number
  south: number
  east: number
  north: number
  startDate: string   // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
  maxCloudCover: number
  formula: 'ndvi' | 'ndwi' | 'nbr'
  /** Output grid resolution per side (default 1024, clamped 256–2048) */
  resolution?: number
}

export interface StacComputeResult {
  output: Float32Array
  width: number
  height: number
  bbox: { west: number; south: number; east: number; north: number }
  sceneId: string
  date: string
  cloudCover: number
  formula: string
  durationMs: number
  backend: 'stac-cog'
}

export interface StacBandsResult {
  bandA: Float32Array
  bandB: Float32Array
  width: number
  height: number
  bbox: { west: number; south: number; east: number; north: number }
  sceneId: string
  date: string
  cloudCover: number
  durationMs: number
}

interface StacItem {
  id: string
  bbox: [number, number, number, number]
  properties: {
    datetime: string
    'eo:cloud_cover': number
    'proj:epsg'?: number
  }
  assets: Record<string, { href: string }>
}

interface StacSearchResponse {
  features: StacItem[]
}

const EARTH_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search'

// Sentinel-2 L2A band to asset name mapping (Element84 Earth Search)
const BAND_ASSETS: Record<string, string> = {
  b02: 'blue',     // 10m
  b03: 'green',    // 10m
  b04: 'red',      // 10m
  b08: 'nir',      // 10m
  b8a: 'nir08',    // 20m
  b11: 'swir16',   // 20m
  b12: 'swir22',   // 20m
}

export class StacCogService {
  /**
   * Search Earth Search STAC for Sentinel-2 L2A scenes.
   */
  async search(opts: StacSearchOptions): Promise<StacItem[]> {
    const body = {
      collections: ['sentinel-2-l2a'],
      bbox: [opts.west, opts.south, opts.east, opts.north],
      datetime: `${opts.startDate}/${opts.endDate}`,
      limit: 20,
      query: {
        'eo:cloud_cover': {
          lt: opts.maxCloudCover,
        },
      },
    }

    const res = await fetch(EARTH_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) throw new Error(`STAC search HTTP ${res.status}`)
    const data = (await res.json()) as StacSearchResponse
    return data.features.sort((a, b) => a.properties['eo:cloud_cover'] - b.properties['eo:cloud_cover'])
  }

  /**
   * Compute a band math index from real Sentinel-2 COG data.
   *
   * @param opts Search + formula options
   * @param targetWidth  Desired output width (cells)
   * @param targetHeight Desired output height (cells)
   */
  async compute(opts: StacSearchOptions, targetWidth?: number, targetHeight?: number): Promise<StacComputeResult> {
    const start = performance.now()
    const res = Math.min(2048, Math.max(256, opts.resolution ?? 1024))
    targetWidth = targetWidth ?? res
    targetHeight = targetHeight ?? res

    // 1. Search for scenes
    const scenes = await this.search(opts)
    if (scenes.length === 0) throw new Error('No Sentinel-2 scenes found for the requested criteria')

    const scene = scenes[0]
    const epsg = scene.properties['proj:epsg'] || 4326
    const crs = `EPSG:${epsg}`

    // 2. Determine which bands to read based on formula
    const { bandA, bandB } = this.getFormulaBands(opts.formula)
    const assetA = BAND_ASSETS[bandA]
    const assetB = BAND_ASSETS[bandB]

    if (!scene.assets[assetA] || !scene.assets[assetB]) {
      throw new Error(`Scene missing required assets: ${assetA}, ${assetB}`)
    }

    const urlA = scene.assets[assetA].href
    const urlB = scene.assets[assetB].href

    // 3. Open COGs with geotiff (fromUrl uses HTTP range requests)
    const [tiffA, tiffB] = await Promise.all([fromUrl(urlA), fromUrl(urlB)])
    const [imageA, imageB] = await Promise.all([tiffA.getImage(), tiffB.getImage()])

    // 4. Compute the pixel window in the COG's native CRS for the bbox
    const window = this.computeWindow(imageA, opts.west, opts.south, opts.east, opts.north, crs)
    const width = Math.min(window.width, targetWidth)
    const height = Math.min(window.height, targetHeight)

    // 5. Read the window, resampling if needed
    const dataA = await this.readWindow(imageA, window, width, height)
    const dataB = await this.readWindow(imageB, window, width, height)

    // 6. Compute band math
    const output = new Float32Array(width * height)
    for (let i = 0; i < output.length; i++) {
      const a = dataA[i] / 10000.0 // reflectance
      const b = dataB[i] / 10000.0
      const denom = a + b
      output[i] = denom > 0 ? (b - a) / denom : 0 // NIR minus RED for NDVI, etc.
    }

    // 7. Compute WGS84 bbox from the COG's native window extent
    const bbox = this.windowToWGS84(imageA, window, crs)

    const durationMs = performance.now() - start

    return {
      output,
      width,
      height,
      bbox,
      sceneId: scene.id,
      date: scene.properties.datetime,
      cloudCover: scene.properties['eo:cloud_cover'],
      formula: opts.formula,
      durationMs,
      backend: 'stac-cog',
    }
  }

  /**
   * Fetch two raw Sentinel-2 L2A bands for a WGS84 bbox.
   * Returns reflectance Float32Arrays for renderer-side GPU compute.
   */
  async fetchBands(
    opts: StacSearchOptions,
    targetWidth?: number,
    targetHeight?: number,
  ): Promise<StacBandsResult> {
    const start = performance.now()
    const res = Math.min(2048, Math.max(256, opts.resolution ?? 1024))
    targetWidth = targetWidth ?? res
    targetHeight = targetHeight ?? res

    const scenes = await this.search(opts)
    if (scenes.length === 0) throw new Error('No Sentinel-2 scenes found for the requested criteria')

    const scene = scenes[0]
    const epsg = scene.properties['proj:epsg'] || 4326
    const crs = `EPSG:${epsg}`

    const { bandA, bandB } = this.getFormulaBands(opts.formula)
    const assetA = BAND_ASSETS[bandA]
    const assetB = BAND_ASSETS[bandB]

    if (!scene.assets[assetA] || !scene.assets[assetB]) {
      throw new Error(`Scene missing required assets: ${assetA}, ${assetB}`)
    }

    const [tiffA, tiffB] = await Promise.all([fromUrl(scene.assets[assetA].href), fromUrl(scene.assets[assetB].href)])
    const [imageA, imageB] = await Promise.all([tiffA.getImage(), tiffB.getImage()])

    const window = this.computeWindow(imageA, opts.west, opts.south, opts.east, opts.north, crs)
    const width = Math.min(window.width, targetWidth)
    const height = Math.min(window.height, targetHeight)

    const dataA = await this.readWindow(imageA, window, width, height)
    const dataB = await this.readWindow(imageB, window, width, height)

    const bandAFloat = new Float32Array(width * height)
    const bandBFloat = new Float32Array(width * height)
    for (let i = 0; i < width * height; i++) {
      bandAFloat[i] = dataA[i] / 10000.0
      bandBFloat[i] = dataB[i] / 10000.0
    }

    const bbox = this.windowToWGS84(imageA, window, crs)
    const durationMs = performance.now() - start

    return {
      bandA: bandAFloat,
      bandB: bandBFloat,
      width,
      height,
      bbox,
      sceneId: scene.id,
      date: scene.properties.datetime,
      cloudCover: scene.properties['eo:cloud_cover'],
      durationMs,
    }
  }

  private getFormulaBands(formula: string): { bandA: string; bandB: string } {
    switch (formula) {
      case 'ndvi': return { bandA: 'b04', bandB: 'b08' }  // (B08 - B04) / (B08 + B04)
      case 'ndwi': return { bandA: 'b08', bandB: 'b03' }  // (B03 - B08) / (B03 + B08)
      case 'nbr': return { bandA: 'b11', bandB: 'b08' }  // (B08 - B11) / (B08 + B11)
      default: return { bandA: 'b04', bandB: 'b08' }
    }
  }

  /**
   * Compute pixel window in the COG image for a WGS84 bbox.
   *
   * Converts WGS84 bbox corners to image CRS, then maps to pixel
   * coordinates using the image's geo transform.
   */
  private computeWindow(
    image: GeoTIFFImage,
    west: number, south: number, east: number, north: number,
    crs: string,
  ): { x: number; y: number; width: number; height: number } {
    const fileDirectory = (image as any).fileDirectory
    const tiepoint = fileDirectory.ModelTiepoint || [0, 0, 0, 0, 0, 0]
    const scale = fileDirectory.ModelPixelScale || [1, 1, 1]

    const originX = tiepoint[3]
    const originY = tiepoint[4]
    const pixelWidth = scale[0]
    const pixelHeight = scale[1]

    const imgWidth = image.getWidth()
    const imgHeight = image.getHeight()

    // Reproject bbox to image CRS
    const sw = this.reproject(west, south, 'EPSG:4326', crs)
    const ne = this.reproject(east, north, 'EPSG:4326', crs)

    const minX = Math.min(sw.x, ne.x)
    const maxX = Math.max(sw.x, ne.x)
    const minY = Math.min(sw.y, ne.y)
    const maxY = Math.max(sw.y, ne.y)

    // Map to pixel coordinates (top-left origin)
    const x = Math.floor((minX - originX) / pixelWidth)
    const y = Math.floor((originY - maxY) / Math.abs(pixelHeight))
    const width = Math.ceil((maxX - minX) / pixelWidth)
    const height = Math.ceil((maxY - minY) / Math.abs(pixelHeight))

    // Clamp to image bounds
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.min(imgWidth - Math.max(0, x), Math.max(1, width)),
      height: Math.min(imgHeight - Math.max(0, y), Math.max(1, height)),
    }
  }

  /**
   * Read a window from a COG, resampling to the target size.
   * Uses geotiff's readRasters with width/height override.
   */
  private async readWindow(image: GeoTIFFImage, window: any, width: number, height: number): Promise<Float32Array> {
    const rasters = await image.readRasters({
      window: [window.x, window.y, window.x + window.width, window.y + window.height],
      width,
      height,
      resampleMethod: 'bilinear',
    }) as any

    // rasters[0] is the first band (Sentinel-2 bands are single band)
    const data = rasters[0] as Uint16Array
    return new Float32Array(data as any)
  }

  /**
   * Convert a pixel window extent to WGS84 bounding box.
   */
  private windowToWGS84(image: GeoTIFFImage, window: any, crs: string): { west: number; south: number; east: number; north: number } {
    const fileDirectory = (image as any).fileDirectory
    const tiepoint = fileDirectory.ModelTiepoint || [0, 0, 0, 0, 0, 0]
    const scale = fileDirectory.ModelPixelScale || [1, 1, 1]

    const originX = tiepoint[3]
    const originY = tiepoint[4]
    const pixelWidth = scale[0]
    const pixelHeight = scale[1]

    const minX = originX + window.x * pixelWidth
    const maxX = originX + (window.x + window.width) * pixelWidth
    const maxY = originY - window.y * Math.abs(pixelHeight)
    const minY = originY - (window.y + window.height) * Math.abs(pixelHeight)

    const sw = this.reproject(minX, minY, crs, 'EPSG:4326')
    const ne = this.reproject(maxX, maxY, crs, 'EPSG:4326')

    return {
      west: Math.min(sw.x, ne.x),
      south: Math.min(sw.y, ne.y),
      east: Math.max(sw.x, ne.x),
      north: Math.max(sw.y, ne.y),
    }
  }

  private reproject(x: number, y: number, from: string, to: string): { x: number; y: number } {
    if (from === to) return { x, y }
    const [rx, ry] = proj4(from, to, [x, y])
    return { x: rx, y: ry }
  }
}

export const stacCogService = new StacCogService()
