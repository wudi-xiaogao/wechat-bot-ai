/**
 * 视频帧抽取工具
 *
 * 使用 ffmpeg 从视频中均匀抽取关键帧，转为 base64 图片
 * 供 Vision API 进行视频内容理解
 *
 * 策略：根据视频时长均匀抽取最多 N 帧（默认 3 帧），覆盖视频内容
 * 所有配置从 process.env 动态读取，支持热加载
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)

/**
 * 动态读取配置（支持热加载）
 */
function getVideoConfig() {
  return {
    enabled: process.env.VIDEO_ENABLED !== 'false', // 默认启用
    maxSize: parseInt(process.env.VIDEO_MAX_SIZE) || 50 * 1024 * 1024, // 默认 50MB
    maxFrames: parseInt(process.env.VIDEO_MAX_FRAMES) || 3, // 默认最多 3 帧
    frameQuality: parseInt(process.env.VIDEO_FRAME_QUALITY) || 2, // JPEG 质量 1-31
  }
}

/**
 * 获取视频大小限制
 * @returns {number} 最大视频大小（字节）
 */
export function getMaxVideoSize() {
  return getVideoConfig().maxSize
}

/**
 * 检查视频理解是否启用
 * @returns {boolean}
 */
export function isVideoEnabled() {
  return getVideoConfig().enabled
}

/**
 * 获取视频时长（秒）
 * @param {string} filePath 视频文件路径
 * @returns {Promise<number>} 时长（秒）
 */
async function getVideoDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ])

    const info = JSON.parse(stdout)
    const duration = parseFloat(info?.format?.duration)
    return isNaN(duration) ? 0 : duration
  } catch (e) {
    console.warn('⚠️ 获取视频时长失败，使用默认抽帧策略:', e.message)
    return 0
  }
}

/**
 * 从视频中抽取一帧
 * @param {string} filePath 视频文件路径
 * @param {number} timeSeconds 抽帧时间点（秒）
 * @param {number} frameQuality JPEG 质量
 * @returns {Promise<Buffer|null>} JPEG 帧的 Buffer
 */
async function extractFrame(filePath, timeSeconds, frameQuality) {
  const tmpDir = os.tmpdir()
  const outputPath = path.join(tmpDir, `frame_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`)

  try {
    await execFileAsync('ffmpeg', [
      '-y',                  // 覆盖输出
      '-ss', String(timeSeconds),  // 定位时间点
      '-i', filePath,        // 输入视频
      '-vframes', '1',       // 只取一帧
      '-q:v', String(frameQuality), // JPEG 质量
      '-f', 'image2',        // 输出格式
      outputPath
    ], { timeout: 30000 }) // 30秒超时

    const buffer = fs.readFileSync(outputPath)
    return buffer
  } catch (e) {
    console.warn(`⚠️ 抽帧失败 (时间: ${timeSeconds}s):`, e.message)
    return null
  } finally {
    // 清理临时文件
    try {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    } catch (_) { /* ignore */ }
  }
}

/**
 * 计算抽帧时间点
 * @param {number} duration 视频时长（秒）
 * @param {number} maxFrames 最大帧数
 * @returns {number[]} 抽帧时间点数组
 */
function calculateFrameTimestamps(duration, maxFrames) {
  if (duration <= 0) {
    // 无法获取时长，尝试取第 0 秒
    return [0]
  }

  if (duration <= 3) {
    // 极短视频，取中间
    return [duration / 2]
  }

  const timestamps = []

  if (maxFrames === 1) {
    timestamps.push(duration * 0.5) // 中间帧
  } else if (maxFrames === 2) {
    timestamps.push(duration * 0.25) // 25%
    timestamps.push(duration * 0.75) // 75%
  } else {
    // 均匀分布
    for (let i = 0; i < maxFrames; i++) {
      const ratio = (i + 1) / (maxFrames + 1)
      timestamps.push(duration * ratio)
    }
  }

  return timestamps
}

/**
 * 从视频 Buffer 中抽取关键帧
 *
 * @param {Buffer} videoBuffer 视频的二进制数据
 * @param {Object} options 配置选项
 * @param {number} options.maxFrames 最大抽取帧数（默认从环境变量读取，或 3）
 * @returns {Promise<Array<{imageBase64: string, mimeType: string}>>} 帧的 base64 数组
 */
export async function extractFrames(videoBuffer, options = {}) {
  const config = getVideoConfig()
  const maxFrames = options.maxFrames || config.maxFrames
  const frameQuality = config.frameQuality

  const tmpDir = os.tmpdir()
  const videoPath = path.join(tmpDir, `video_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`)

  try {
    // 1. 写入临时文件
    fs.writeFileSync(videoPath, videoBuffer)
    console.log(`📹 临时视频文件: ${videoPath} (${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB)`)

    // 2. 获取视频时长
    const duration = await getVideoDuration(videoPath)
    console.log(`📹 视频时长: ${duration.toFixed(1)}s, 计划抽取 ${maxFrames} 帧`)

    // 3. 计算抽帧时间点
    const timestamps = calculateFrameTimestamps(duration, maxFrames)

    // 4. 逐帧抽取
    const frames = []
    for (const ts of timestamps) {
      const frameBuffer = await extractFrame(videoPath, ts, frameQuality)
      if (frameBuffer) {
        frames.push({
          imageBase64: frameBuffer.toString('base64'),
          mimeType: 'image/jpeg'
        })
        console.log(`✅ 抽帧成功 (时间: ${ts.toFixed(1)}s, 大小: ${(frameBuffer.length / 1024).toFixed(1)}KB)`)
      }
    }

    if (frames.length === 0) {
      console.warn('⚠️ 所有抽帧尝试失败，将使用第 0 秒重试')
      // 最后尝试：取第 0 秒
      const fallbackBuffer = await extractFrame(videoPath, 0, frameQuality)
      if (fallbackBuffer) {
        frames.push({
          imageBase64: fallbackBuffer.toString('base64'),
          mimeType: 'image/jpeg'
        })
      }
    }

    console.log(`📹 共成功抽取 ${frames.length} 帧`)
    return frames

  } finally {
    // 5. 清理临时文件
    try {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath)
    } catch (_) { /* ignore */ }
  }
}
