import crypto from 'crypto';

const B2_KEY_ID = process.env.B2_KEY_ID || '0053320e36b0cf00000000001';
const B2_APP_KEY = process.env.B2_APP_KEY || 'K005tEzNWdZ1bL9WXXk5No9w8hap0DM';
const B2_BUCKET_ID = process.env.B2_BUCKET_ID || '9313a270bec3162ba02c0f10';
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || 'FeaturesticBox';

let cachedAuth = null;
let cachedAuthAt = 0;

export async function authorizeB2() {
  if (cachedAuth && Date.now() - cachedAuthAt < 10 * 60 * 60 * 1000) {
    return cachedAuth;
  }
  const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64')
    }
  });
  if (!res.ok) {
    throw new Error(`B2 auth failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  cachedAuth = data;
  cachedAuthAt = Date.now();
  return data;
}

export async function uploadToB2(fileName, buffer, contentType = 'application/octet-stream') {
  const auth = await authorizeB2();
  const upUrlRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ bucketId: B2_BUCKET_ID })
  });
  if (!upUrlRes.ok) {
    throw new Error(`B2 get_upload_url failed: HTTP ${upUrlRes.status}`);
  }
  const upInfo = await upUrlRes.json();
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  const encodedName = encodeURIComponent(fileName).replace(/%2F/g, '/');

  const upRes = await fetch(upInfo.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: upInfo.authorizationToken,
      'X-Bz-File-Name': encodedName,
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
      'X-Bz-Content-Sha1': sha1
    },
    body: buffer
  });
  if (!upRes.ok) {
    const errText = await upRes.text().catch(() => '');
    throw new Error(`B2 upload failed: HTTP ${upRes.status} ${errText}`);
  }
  return await upRes.json();
}

export async function getSignedDownloadUrl(fileName, validSeconds = 3600) {
  const auth = await authorizeB2();
  const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_download_authorization`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      bucketId: B2_BUCKET_ID,
      fileNamePrefix: fileName,
      validDurationInSeconds: validSeconds
    })
  });
  if (!res.ok) {
    throw new Error(`B2 download auth failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  const encodedName = encodeURIComponent(fileName).replace(/%2F/g, '/');
  return `${auth.downloadUrl}/file/${B2_BUCKET_NAME}/${encodedName}?Authorization=${encodeURIComponent(data.authorizationToken)}`;
}
