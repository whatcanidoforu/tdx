/**
 * 钉钉企业内部应用 —— 发送文件消息（xlsx 等）。
 *
 * 为什么需要：群机器人 Webhook 不支持发送文件，只能发文本/链接。
 * 企业内部应用可以走「工作通知」把文件推到钉钉，手机能直接下载预览。
 *
 * 链路：
 *   1. 用 AppKey/AppSecret 换 access_token（有效期 2 小时，自动缓存）
 *   2. 上传文件到 media/upload 拿到 media_id（保留 3 天）
 *   3. 调工作通知接口把 file 消息发给指定 userid
 *
 * 前置条件（在钉钉开放平台配置）：
 *   · 应用已创建，拿到 AppKey / AppSecret
 *   · 应用详情页能看到 AgentId
 *   · 接收人必须在「应用可见范围」内
 *   · 开通权限：工作通知（qyapi_message_send_corpconversation）
 *
 * @module app/push/dingtalk-file
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** access_token 缓存（钉钉返回有效期 7200 秒，提前 5 分钟刷新）。 */
let tokenCache = { token: null, expiresAt: 0, appKey: null };

/** 文件大小上限（钉钉 media/upload 限制 20MB）。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * 获取 access_token（带缓存）。
 *
 * @param {string} appKey
 * @param {string} appSecret
 * @returns {Promise<string>}
 */
export async function getAccessToken(appKey, appSecret) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.appKey === appKey && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await response.json();
  if (json.errcode !== 0) {
    throw new Error(`获取 access_token 失败：errcode=${json.errcode} ${json.errmsg}`);
  }
  tokenCache = {
    token: json.access_token,
    expiresAt: now + (json.expires_in - 300) * 1000,
    appKey,
  };
  return json.access_token;
}

/** 清空 token 缓存（测试用）。 */
export function clearTokenCache() {
  tokenCache = { token: null, expiresAt: 0, appKey: null };
}

/**
 * 上传文件，返回 media_id。
 *
 * @param {{accessToken: string, filePath: string}} options
 * @returns {Promise<string>}
 */
export async function uploadMedia(options) {
  const stat = statSync(options.filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），钉钉上限 20 MB`);
  }
  // type: file（默认，发文件用）或 image（发图片用）
  const mediaType = options.type === 'image' ? 'image' : 'file';
  const buffer = readFileSync(options.filePath);
  const form = new FormData();
  const mimeType = mediaType === 'image' ? 'image/png' : 'application/octet-stream';
  form.append('media', new Blob([buffer], { type: mimeType }), basename(options.filePath));

  const response = await fetch(
    `https://oapi.dingtalk.com/media/upload?access_token=${options.accessToken}&type=${mediaType}`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(60000) },
  );
  const json = await response.json();
  if (json.errcode !== 0) {
    throw new Error(`上传文件失败：errcode=${json.errcode} ${json.errmsg}`);
  }
  if (!json.media_id) {
    throw new Error('上传成功但没拿到 media_id');
  }
  return json.media_id;
}

/**
 * 发送工作通知（支持 text / file 等消息类型）。
 *
 * @param {{
 *   accessToken: string,
 *   agentId: number|string,
 *   userIds: string[],
 *   msg: object,
 * }} options
 * @returns {Promise<{taskId: number}>}
 */
export async function sendWorkNotice(options) {
  const response = await fetch(
    `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${options.accessToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: Number(options.agentId),
        userid_list: options.userIds.join(','),
        msg: options.msg,
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const json = await response.json();
  if (json.errcode !== 0) {
    throw new Error(`发送工作通知失败：errcode=${json.errcode} ${json.errmsg}`);
  }
  return { taskId: json.task_id };
}

/**
 * 发送文件消息给指定用户。
 *
 * @param {{
 *   appKey: string,
 *   appSecret: string,
 *   agentId: number|string,
 *   userIds: string[],
 *   filePath: string,
 * }} options
 * @returns {Promise<{mediaId: string, taskId: number}>}
 */
export async function sendFile(options) {
  if (!options.agentId) {
    throw new Error('缺少 agentId（在钉钉开放平台应用详情页查看）');
  }
  if (!options.userIds || options.userIds.length === 0) {
    throw new Error('缺少接收人 userid');
  }
  const accessToken = await getAccessToken(options.appKey, options.appSecret);
  const mediaId = await uploadMedia({ accessToken, filePath: options.filePath });
  const { taskId } = await sendWorkNotice({
    accessToken,
    agentId: options.agentId,
    userIds: options.userIds,
    msg: { msgtype: 'file', file: { media_id: mediaId } },
  });
  return { mediaId, taskId };
}

/**
 * 发送图片工作通知。
 *
 * 图片走 media/upload（type=image），再用 asyncsend_v2 的 image 消息类型。
 * 注意：Webhook 群机器人不支持发图片，只能走企业内部应用。
 *
 * @param {{
 *   appKey: string,
 *   appSecret: string,
 *   agentId: number|string,
 *   userIds: string[],
 *   imagePath: string,
 * }} options
 * @returns {Promise<{mediaId: string, taskId: number}>}
 */
export async function sendImage(options) {
  if (!options.agentId) {
    throw new Error('缺少 agentId（在钉钉开放平台应用详情页查看）');
  }
  if (!options.userIds || options.userIds.length === 0) {
    throw new Error('缺少接收人 userid');
  }
  const accessToken = await getAccessToken(options.appKey, options.appSecret);
  // 图片的 type 必须是 image，文件是 file
  const mediaId = await uploadMedia({
    accessToken,
    filePath: options.imagePath,
    type: 'image',
  });
  const { taskId } = await sendWorkNotice({
    accessToken,
    agentId: options.agentId,
    userIds: options.userIds,
    msg: { msgtype: 'image', image: { media_id: mediaId } },
  });
  return { mediaId, taskId };
}

/**
 * 发送文本工作通知（不依赖 media，用于测试连通性/告警）。
 *
 * @param {object} options
 */
export async function sendTextNotice(options) {
  const accessToken = await getAccessToken(options.appKey, options.appSecret);
  return sendWorkNotice({
    accessToken,
    agentId: options.agentId,
    userIds: options.userIds,
    msg: { msgtype: 'text', text: { content: options.content } },
  });
}

/**
 * 查询工作通知的发送结果。
 *
 * @param {{accessToken: string, taskId: number}} options
 */
export async function getSendResult(options) {
  const response = await fetch(
    `https://oapi.dingtalk.com/topapi/message/corpconversation/getsendresult?access_token=${options.accessToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 1, task_id: options.taskId }),
      signal: AbortSignal.timeout(15000),
    },
  );
  return response.json();
}
