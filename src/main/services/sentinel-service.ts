/**
 * Satellite Imagery Service — NASA GIBS (Global Imagery Browse Services).
 * Ported from OSINT-Global-OS. No API key required.
 *
 * Endpoint: https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/
 * Format:   {layer}/default/{time}/{TileMatrixSet}/{z}/{y}/{x}.{format}
 *
 * Note: GIBS WMTS requires standard tile matrix set IDs (GoogleMapsCompatible_LevelN),
 * not resolution aliases like "250m". The date "default" returns the latest available.
 */

import type { LngLat, GIBSLayer, SentinelScene, SentinelRequest, SentinelResponse } from '@shared/types'

export const GIBS_LAYERS: GIBSLayer[] = [
  {
    id: 'modis-true-color',
    name: 'MODIS True Color',
    gibsLayer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    format: 'jpeg',
    tileMatrixSet: 'GoogleMapsCompatible_Level9',
    maxZoom: 9,
    temporalResolution: 'Daily',
    description: 'Terra MODIS true color — daily, 250m resolution',
    category: 'true-color',
  },
  {
    id: 'modis-bands-721',
    name: 'MODIS 7-2-1 (Vegetation)',
    gibsLayer: 'MODIS_Terra_CorrectedReflectance_Bands721',
    format: 'jpeg',
    tileMatrixSet: 'GoogleMapsCompatible_Level9',
    maxZoom: 9,
    temporalResolution: 'Daily',
    description: 'False color — vegetation appears green, water black, burn scars red',
    category: 'false-color',
  },
  {
    id: 'viirs-true-color',
    name: 'VIIRS True Color',
    gibsLayer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    format: 'jpeg',
    tileMatrixSet: 'GoogleMapsCompatible_Level9',
    maxZoom: 9,
    temporalResolution: 'Daily',
    description: 'Suomi NPP VIIRS true color — daily, 300m resolution',
    category: 'true-color',
  },
  {
    id: 'viirs-dnb',
    name: 'VIIRS Day/Night',
    gibsLayer: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level8',
    maxZoom: 8,
    temporalResolution: 'Daily',
    description: 'Nighttime lights — useful for detecting remote activity',
    category: 'true-color',
  },
  {
    id: 'landsat-weld',
    name: 'Landsat WELD',
    gibsLayer: 'Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual',
    format: 'jpeg',
    tileMatrixSet: 'GoogleMapsCompatible_Level12',
    maxZoom: 12,
    temporalResolution: 'Annual',
    description: 'Landsat annual mosaic — 30m resolution, cloud-free composite',
    category: 'true-color',
  },
  {
    id: 'modis-lst-night',
    name: 'Land Surface Temp (Night)',
    gibsLayer: 'MODIS_Aqua_Land_Surface_Temp_Night',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level7',
    maxZoom: 8,
    temporalResolution: 'Daily',
    description: 'Aqua MODIS nighttime land surface temperature — thermal',
    category: 'thermal',
  },
  {
    id: 'modis-lst-day',
    name: 'Land Surface Temp (Day)',
    gibsLayer: 'MODIS_Terra_Land_Surface_Temp_Day',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level7',
    maxZoom: 8,
    temporalResolution: 'Daily',
    description: 'Terra MODIS daytime land surface temperature — thermal',
    category: 'thermal',
  },
  {
    id: 'modis-ndvi',
    name: 'MODIS NDVI (16-day)',
    gibsLayer: 'MODIS_Terra_NDVI_16Day',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level8',
    maxZoom: 8,
    temporalResolution: '16-day',
    description: 'Terra MODIS Normalized Difference Vegetation Index — 16-day composite',
    category: 'vegetation',
  },
  {
    id: 'sentinel-2-mosaic',
    name: 'Sentinel-2 Mosaic (20m)',
    gibsLayer: 'Sentinel_2_L2A_Mosaic_20m',
    format: 'jpeg',
    tileMatrixSet: 'GoogleMapsCompatible_Level14',
    maxZoom: 14,
    temporalResolution: 'Daily',
    description: 'Sentinel-2 L2A mosaic — 20m resolution, cloud-free composite',
    category: 'true-color',
  },
  {
    id: 'goes-east',
    name: 'GOES-East (15-min)',
    gibsLayer: 'GOES-East_ABI_Band2_Red_Visible_1km',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level7',
    maxZoom: 7,
    temporalResolution: '15-min',
    description: 'GOES-East ABI visible band — 15-minute geostationary imagery',
    category: 'geostationary',
  },
  {
    id: 'himawari-8',
    name: 'Himawari-8 (10-min)',
    gibsLayer: 'Himawari-8_AHI_Band2_Red_Visible_1km',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level7',
    maxZoom: 7,
    temporalResolution: '10-min',
    description: 'Himawari-8 AHI visible band — 10-minute geostationary imagery',
    category: 'geostationary',
  },
  {
    id: 'meteosat-11',
    name: 'Meteosat-11 (15-min)',
    gibsLayer: 'Meteosat_Second_Generation_West_Indian_Ocean_True_Color',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level7',
    maxZoom: 7,
    temporalResolution: '15-min',
    description: 'Meteosat-11 SEVIRI true color — 15-minute geostationary imagery',
    category: 'geostationary',
  },
  {
    id: 'omi-ozone',
    name: 'OMI Ozone (Total Column)',
    gibsLayer: 'OMI_Ozone_TOMS_Total_Column',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level6',
    maxZoom: 6,
    temporalResolution: 'Daily',
    description: 'Aura OMI total column ozone — TOMS-like, daily',
    category: 'atmosphere',
  },
  {
    id: 'modis-aerosol',
    name: 'MODIS Aerosol Optical Depth',
    gibsLayer: 'MODIS_Terra_Aerosol',
    format: 'png',
    tileMatrixSet: 'GoogleMapsCompatible_Level6',
    maxZoom: 6,
    temporalResolution: 'Daily',
    description: 'Terra MODIS aerosol optical depth — 3 km, daily',
    category: 'atmosphere',
  },
]

const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'

function buildGibsTileUrl(layer: GIBSLayer, date: string): string {
  return `${GIBS_BASE}/${layer.gibsLayer}/default/${date}/${layer.tileMatrixSet}/{z}/{y}/{x}.${layer.format}`
}

function yesterdayISO(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return d.toISOString().split('T')[0]
}

export function getGibsLayerById(id: string): GIBSLayer | undefined {
  return GIBS_LAYERS.find((l) => l.id === id)
}

export function buildLayerTileUrl(layerId: string, date?: string): string {
  const layer = getGibsLayerById(layerId) ?? GIBS_LAYERS[0]
  return buildGibsTileUrl(layer, date ?? yesterdayISO())
}

export async function searchSentinelScenes(req: SentinelRequest): Promise<SentinelResponse> {
  const [sw, ne] = req.bounds
  const targetDate = req.date ?? yesterdayISO()
  const limit = req.limit ?? 5

  const layer = req.layerId
    ? getGibsLayerById(req.layerId) ?? GIBS_LAYERS[0]
    : GIBS_LAYERS[0]

  const tileUrl = buildGibsTileUrl(layer, targetDate)

  const best: SentinelScene = {
    id: layer.id,
    tileUrl,
    date: targetDate,
    cloudCover: 0,
    bounds: [
      { lng: sw.lng, lat: sw.lat },
      { lng: ne.lng, lat: ne.lat },
    ],
    isImageOverlay: false,
    maxZoom: layer.maxZoom,
  }

  const scenes: SentinelScene[] = GIBS_LAYERS.slice(0, limit).map((l) => ({
    id: l.id,
    tileUrl: buildGibsTileUrl(l, targetDate),
    date: targetDate,
    cloudCover: 0,
    bounds: [
      { lng: sw.lng, lat: sw.lat },
      { lng: ne.lng, lat: ne.lat },
    ],
    isImageOverlay: false,
    maxZoom: l.maxZoom,
  }))

  return { layers: GIBS_LAYERS, best, scenes }
}
