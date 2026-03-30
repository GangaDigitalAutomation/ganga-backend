import { describe, test, expect } from "bun:test";
import { api, expectStatus } from "./helpers";

describe("API Integration Tests", () => {
  // Shared state for chaining tests
  let channelId: string;
  let videoIds: string[] = [];
  let scheduleId: string;

  // ============= CHANNELS TESTS =============

  test("Get all channels", async () => {
    const res = await api("/api/channels");
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.channels).toBeDefined();
    expect(Array.isArray(data.channels)).toBe(true);
  });

  test("Create a channel", async () => {
    const res = await api("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Channel",
        client_id: "test-client-id",
        client_secret: "test-client-secret",
      }),
    });
    await expectStatus(res, 201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.name).toBe("Test Channel");
    expect(data.client_id).toBe("test-client-id");
    channelId = data.id;
  });

  test("Get channel by ID", async () => {
    const res = await api(`/api/channels/${channelId}`);
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.id).toBe(channelId);
    expect(data.name).toBe("Test Channel");
  });

  test("Update channel", async () => {
    const res = await api(`/api/channels/${channelId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated Channel",
        is_starred: true,
      }),
    });
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.name).toBe("Updated Channel");
    expect(data.is_starred).toBe(true);
  });

  test("Get non-existent channel returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await api(`/api/channels/${fakeId}`);
    await expectStatus(res, 404);
  });

  test("Get OAuth URL for channel", async () => {
    const res = await api(
      `/api/channels/${channelId}/oauth-url?redirect_uri=http://localhost:3000/callback`
    );
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.url).toBeDefined();
  });

  test("OAuth callback with non-existent channel returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await api(`/api/channels/${fakeId}/oauth-callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "test-code",
        redirect_uri: "http://localhost:3000/callback",
      }),
    });
    await expectStatus(res, 404);
  });

  test("Delete channel", async () => {
    const res = await api(`/api/channels/${channelId}`, {
      method: "DELETE",
    });
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("Get deleted channel returns 404", async () => {
    const res = await api(`/api/channels/${channelId}`);
    await expectStatus(res, 404);
  });

  // ============= VIDEOS TESTS =============

  test("Get all videos", async () => {
    const res = await api("/api/videos");
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.videos).toBeDefined();
    expect(Array.isArray(data.videos)).toBe(true);
    expect(typeof data.total_size_bytes).toBe("number");
  });

  test("Bulk insert videos", async () => {
    const res = await api("/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videos: [
          {
            name: "Test Video 1",
            file_path: "/videos/test1.mp4",
            size_bytes: 1024000,
            extension: "mp4",
          },
          {
            name: "Test Video 2",
            file_path: "/videos/test2.mp4",
            size_bytes: 2048000,
            extension: "mp4",
          },
        ],
      }),
    });
    await expectStatus(res, 201);
    const data = await res.json();
    expect(data.videos).toBeDefined();
    expect(Array.isArray(data.videos)).toBe(true);
    expect(data.videos.length).toBe(2);
    videoIds = data.videos.map((v: any) => v.id);
  });

  test("Delete a specific video", async () => {
    const videoId = videoIds[0];
    const res = await api(`/api/videos/${videoId}`, {
      method: "DELETE",
    });
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("Delete non-existent video returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await api(`/api/videos/${fakeId}`, {
      method: "DELETE",
    });
    await expectStatus(res, 404);
  });

  test("Delete all videos", async () => {
    const res = await api("/api/videos", {
      method: "DELETE",
    });
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  // ============= SCHEDULES TESTS =============

  test("Create a channel for schedules", async () => {
    const res = await api("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Schedule Test Channel",
        client_id: "schedule-client-id",
        client_secret: "schedule-client-secret",
      }),
    });
    await expectStatus(res, 201);
    const data = await res.json();
    channelId = data.id;
  });

  test("Insert a video for schedules", async () => {
    const res = await api("/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videos: [
          {
            name: "Schedule Video",
            file_path: "/videos/schedule.mp4",
            size_bytes: 5000000,
            extension: "mp4",
          },
        ],
      }),
    });
    await expectStatus(res, 201);
    const data = await res.json();
    videoIds = [data.videos[0].id];
  });

  test("Get all schedules", async () => {
    const res = await api("/api/schedules");
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.schedules).toBeDefined();
    expect(Array.isArray(data.schedules)).toBe(true);
  });

  test("Create a schedule", async () => {
    const res = await api("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        video_id: videoIds[0],
        scheduled_at: "2026-03-25T10:00:00Z",
      }),
    });
    await expectStatus(res, 201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.channel_id).toBe(channelId);
    expect(data.video_id).toBe(videoIds[0]);
    scheduleId = data.id;
  });

  test("Get schedules filtered by channel_id", async () => {
    const res = await api(`/api/schedules?channel_id=${channelId}`);
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.schedules).toBeDefined();
    expect(Array.isArray(data.schedules)).toBe(true);
  });

  test("Bulk insert schedules", async () => {
    const res = await api("/api/schedules/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schedules: [
          {
            channel_id: channelId,
            video_id: videoIds[0],
            scheduled_at: "2026-03-26T10:00:00Z",
          },
          {
            channel_id: channelId,
            video_id: videoIds[0],
            scheduled_at: "2026-03-27T10:00:00Z",
          },
        ],
      }),
    });
    await expectStatus(res, 201);
    const data = await res.json();
    expect(data.schedules).toBeDefined();
    expect(Array.isArray(data.schedules)).toBe(true);
    expect(data.count).toBeGreaterThanOrEqual(2);
  });

  test("Delete a specific schedule", async () => {
    const res = await api(`/api/schedules/${scheduleId}`, {
      method: "DELETE",
    });
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("Delete non-existent schedule returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await api(`/api/schedules/${fakeId}`, {
      method: "DELETE",
    });
    await expectStatus(res, 404);
  });

  test("Delete all schedules for channel", async () => {
    const res = await api(`/api/schedules/clear?channel_id=${channelId}`, {
      method: "DELETE",
    });
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  // ============= UPLOAD TESTS =============

  test("Get upload status", async () => {
    const res = await api("/api/upload/status");
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.is_running).toBeDefined();
    expect(typeof data.is_running).toBe("boolean");
    expect(data.total).toBeDefined();
    expect(data.completed).toBeDefined();
    expect(data.failed).toBeDefined();
    expect(data.pending).toBeDefined();
    expect(data.progress_percent).toBeDefined();
  });

  test("Start upload process", async () => {
    const res = await api("/api/upload/start", {
      method: "POST",
    });
    // May return 200 or 400 depending on state, just verify no 500
    expect([200, 400]).toContain(res.status);
  });

  // ============= LOGS TESTS =============

  test("Get logs", async () => {
    const res = await api("/api/logs");
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.logs).toBeDefined();
    expect(Array.isArray(data.logs)).toBe(true);
  });

  test("Get logs with limit parameter", async () => {
    const res = await api("/api/logs?limit=10");
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.logs).toBeDefined();
    expect(Array.isArray(data.logs)).toBe(true);
  });

  // ============= STATS TESTS =============

  test("Get application statistics", async () => {
    const res = await api("/api/stats");
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.total_channels).toBeDefined();
    expect(data.total_videos).toBeDefined();
    expect(data.total_scheduled).toBeDefined();
    expect(data.total_size_bytes).toBeDefined();
    expect(data.connected_channels).toBeDefined();
  });
});
