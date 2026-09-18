import * as Cesium from 'cesium'
import type { GIBSLayer } from '@shared/types'

/**
 * Cesium built-in Natural Earth II — low-res global base that covers the poles
 * (geographic tiling). Used as the permanent underlay so Web-Mercator Esri
 * tiles don't leave polar holes.
 */
export function buildNaturalEarthProvider(): Cesium.ImageryProvider {
  return new Cesium.UrlTemplateImageryProvider({
    url: Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII/{z}/{x}/{reverseY}.jpg'),
    tilingScheme: new Cesium.GeographicTilingScheme(),
    // Cesium's bundled NaturalEarthII tileset only ships levels 0–2 —
    // anything higher is a guaranteed 404/ERR_FILE_NOT_FOUND.
    maximumLevel: 2,
    credit: new Cesium.Credit('Natural Earth'),
  })
}

/**
 * NASA GIBS Blue Marble in EPSG:4326 — geographic tiling that reaches the poles
 * and fills the Web Mercator holes left by Esri/Bing layers.
 */
export function buildGibs4326Provider(): Cesium.ImageryProvider {
  return new Cesium.WebMapTileServiceImageryProvider({
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/{Style}/default/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpeg',
    layer: 'BlueMarble_NextGeneration',
    style: 'default',
    tileMatrixSetID: '500m',
    format: 'image/jpeg',
    maximumLevel: 5,
    tilingScheme: new Cesium.GeographicTilingScheme(),
    credit: new Cesium.Credit('NASA GIBS Blue Marble'),
  })
}
export function buildGibsProvider(layer: GIBSLayer): Cesium.ImageryProvider {
  const date = 'default'
  const base = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
  const url = `${base}/${layer.gibsLayer}/default/${date}/${layer.tileMatrixSet}/{z}/{y}/{x}.${layer.format}`

  return new Cesium.UrlTemplateImageryProvider({
    url,
    maximumLevel: layer.maxZoom,
    credit: new Cesium.Credit(`NASA GIBS — ${layer.name}`),
  })
}

/**
 * Esri World Imagery — high-res satellite basemap.
 * Includes Sentinel-2 imagery at zoom levels 13+ for many regions.
 * This is our "Sentinel-2 base layer" — it's the most reliable free
 * satellite imagery source that includes S2 data.
 *
 * Clamped to the Web Mercator latitude limits so it doesn't paint black
 * tiles over the poles; the polar underlay shows through at high latitudes.
 */
export function buildEsriProvider(): Cesium.ImageryProvider {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // Cap at 18 — ~0.6m/px at deepest zoom. Level 19 exists in some regions
    // but quadruples tile requests; tileCacheSize (100) bounds memory.
    maximumLevel: 18,
    rectangle: Cesium.Rectangle.fromDegrees(-180, -85.0511, 180, 85.0511),
    credit: new Cesium.Credit('Esri World Imagery (includes Sentinel-2)'),
  })
}

/**
 * Esri World Transportation — roads, highways, rail.
 * Transparent background. Designed to overlay on top of World Imagery.
 * Ported from OSINT-Global-OS (MapCanvas.tsx esri_transportation layer).
 */
export function buildEsriTransportationProvider(): Cesium.ImageryProvider {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 17,
    credit: new Cesium.Credit('Esri World Transportation'),
  })
}

/**
 * Esri World Boundaries and Places — roads, place labels, boundaries.
 * Transparent background. Designed to overlay on top of World Imagery.
 * Ported from OSINT-Global-OS (MapCanvas.tsx esri_reference layer).
 */
export function buildEsriReferenceProvider(): Cesium.ImageryProvider {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 17,
    credit: new Cesium.Credit('Esri World Boundaries and Places'),
  })
}

/**
 * 3D terrain provider — ArcGIS World Elevation (built-in Cesium provider).
 * Uses `fromUrl` async factory. No manual PNG decode — Cesium handles it natively.
 */
export async function buildTerrainProvider(): Promise<Cesium.ArcGISTiledElevationTerrainProvider> {
  return await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
    'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer',
  )
}

/** Flat ellipsoid terrain — no 3D elevation. */
export function buildFlatTerrain(): Cesium.EllipsoidTerrainProvider {
  return new Cesium.EllipsoidTerrainProvider()
}
