import { z } from "zod";
import {
  workSchema,
  itemSchema,
  nodeSchema,
  validateWork,
  safeMedia,
  type Work,
} from "../schema";
import { registry } from "../registry";
import { validateGraph } from "../engine";
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, "需要稳定的英文 ID");
const content = itemSchema
  .partial()
  .extend({ id, title: z.string().default(""), body: z.string().default("") })
  .strict();
const event = nodeSchema
  .partial()
  .extend({
    id,
    label: z.string(),
    type: nodeSchema.shape.type.default("event"),
  })
  .strict();
export const storySchema = z
  .object({
    scriptVersion: z.literal(1),
    id,
    title: z.string().min(1),
    description: z.string().default(""),
    revision: z.number().int().positive().default(1),
    phone: workSchema.shape.phone
      .partial()
      .extend({
        owner: z.string(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .default("2026-10-23"),
      })
      .strict(),
    // 双手机模式（紧急联络人）：player = 现实时间线锚点，juyeon = 平行世界持久设备
    devices: z
      .object({
        player: z.lazy(() => deviceSchema),
        juyeon: z.lazy(() => deviceSchema),
      })
      .optional(),
    installedApps: z
      .array(z.union([z.string(), workSchema.shape.apps.element]))
      .default([
        "appstore",
        "phone",
        "messages",
        "photos",
        "notes",
        "safari",
        "settings",
      ]),
    contacts: z
      .array(
        z.object({
          id,
          name: z.string(),
          phone: z.string().default(""),
          avatar: z.string().default(""),
          bio: z.string().default(""),
        }),
      )
      .default([]),
    chats: z
      .array(
        z.object({
          id,
          app: z.string().default("messages"),
          title: z.string(),
          participants: z.array(z.string()),
          messages: z.array(
            content.extend({ senderId: z.string().optional() }),
          ),
        }),
      )
      .default([]),
    content: z.record(z.string(), z.array(content)).default({}),
    variables: workSchema.shape.variables.default({}),
    events: z.array(event).default([]),
    tests: z
      .array(
        z.object({
          name: z.string(),
          vars: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .default({}),
          steps: z.array(
            z.object({
              event: z.string().optional(),
              target: z.string().default(""),
              advanceMs: z.number().min(0).optional(),
              choose: z.string().optional(),
              password: z.string().optional(),
              device: z.enum(["player", "juyeon"]).optional(),
            }),
          ),
          ending: z.string(),
          expectUnlocked: z.array(z.string()).default([]),
        }),
      )
      .default([]),
  })
  .strict();
export type Story = z.infer<typeof storySchema>;

// 双手机设备段：每台设备有自己的机主/外观/已装 App/聊天/内容；contacts 与 events 全局共享
const deviceSchema = z
  .object({
    phone: workSchema.shape.phone
      .partial()
      .extend({
        owner: z.string(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .default("2026-10-23"),
      })
      .strict(),
    installedApps: z
      .array(z.union([z.string(), workSchema.shape.apps.element]))
      .default([
        "appstore",
        "phone",
        "messages",
        "photos",
        "notes",
        "safari",
        "settings",
      ]),
    contacts: z.array(z.string()).default([]), // 在这台设备上生成名片的联系人 id
    chats: z
      .array(
        z.object({
          id,
          app: z.string().default("messages"),
          title: z.string(),
          participants: z.array(z.string()),
          messages: z.array(
            content.extend({ senderId: z.string().optional() }),
          ),
        }),
      )
      .default([]),
    content: z.record(z.string(), z.array(content)).default({}),
  })
  .strict();
export class StoryIssue extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
export function compileStory(raw: unknown): { story: Story; work: Work } {
  const s = storySchema.parse(raw);
  const fail = (p: string, m: string): never => {
    throw new StoryIssue(p, m);
  };
  const names = new Set<string>();
  const unique = (v: string, p: string) => {
    if (names.has(v)) fail(p, "重复 ID: " + v);
    names.add(v);
  };
  const contacts = new Map(s.contacts.map((c) => [c.id, c]));
  s.contacts.forEach((c, i) => unique(c.id, `contacts.${i}.id`));

  // 双手机：把每台设备的 chats/content/联系人名片装入独立数据池；单设备作品行为不变
  const devices: { id: "player" | "juyeon"; s: Story; dev?: z.infer<typeof deviceSchema> }[] =
    s.devices
      ? [
          { id: "player", s, dev: s.devices.player },
          { id: "juyeon", s, dev: s.devices.juyeon },
        ]
      : [{ id: "player", s }];
  const devicePools: Record<string, Work["data"]> = {};
  const deviceWorks: Partial<NonNullable<Work["phones"]>> = {};
  for (const d of devices) {
    const dev = d.dev;
    const phoneCfg: Work["phone"] = {
      passcode: "",
      wallpaper: "sage",
      theme: "light",
      time: "21:41",
      battery: 86,
      network: "5G",
      notifications: true,
      ...(dev ? dev.phone : s.phone),
    };
    const owner = phoneCfg.owner;
    const devDate = phoneCfg.date;
    const devTime = phoneCfg.time || "21:41";
    const devApps = dev ? dev.installedApps : s.installedApps;
    const configuredIds = devApps.map((a) =>
      typeof a === "string" ? a : a.id,
    );
    const devInstalled = new Set(
      devApps
        .filter((a) => typeof a === "string" || a.installed)
        .map((a) => (typeof a === "string" ? a : a.id)),
    );
    if (new Set(configuredIds).size !== devApps.length)
      fail(dev ? `devices.${d.id}.installedApps` : "installedApps", "App 重复");
    devApps.forEach((a, i) => {
      if (!registry.some((r) => r.id === (typeof a === "string" ? a : a.id)))
        fail(
          dev ? `devices.${d.id}.installedApps.${i}` : `installedApps.${i}`,
          "未注册的 App",
        );
    });
    const data: Work["data"] = {};
    const add = (
      app: string,
      raw: Partial<z.infer<typeof itemSchema>>,
      p: string,
    ) => {
      if (!devInstalled.has(app)) fail(p, `App ${app} 未安装`);
      unique(raw.id!, p + ".id");
      const item = itemSchema.parse({
        time: devDate + " " + devTime,
        sender: owner,
        ...raw,
      });
      for (const k of ["media", "avatar"] as const)
        if (item[k] && !safeMedia(item[k]))
          fail(p + "." + k, "仅允许受支持的内嵌媒体，不允许脚本或远程资源");
      if (item.richText) {
        let doc;
        try {
          doc = JSON.parse(item.richText);
        } catch {
          fail(p + ".richText", "必须是结构化富文本 JSON，不能导入 HTML");
        }
        if (!doc || typeof doc !== "object") fail(p + ".richText", "无效富文本");
      }
      (data[app] ??= []).push(item);
    };
    const contentSrc = dev ? dev.content : s.content;
    for (const [app, items] of Object.entries(contentSrc))
      items.forEach((i, n) =>
        add(app, i, (dev ? `devices.${d.id}.` : "") + `content.${app}.${n}`),
      );
    const contactIds = dev ? dev.contacts : s.contacts.map((c) => c.id);
    contactIds.forEach((cid, n) => {
      const c = contacts.get(cid);
      if (!c)
        fail(
          (dev ? `devices.${d.id}.` : "") + `contacts.${n}`,
          "联系人不存在: " + cid,
        );
      if (c!.avatar && !safeMedia(c!.avatar))
        fail(`contacts.${n}.avatar`, "无效头像");
      if (devInstalled.has("contacts"))
        add(
          "contacts",
          {
            // 双手机：同一联系人在两台设备上各有一张名片，ID 需要区分
            id: dev ? `${c!.id}-card-${d.id}` : `${c!.id}-card`,
            title: c!.name,
            body: c!.bio,
            meta: { phone: c!.phone },
            avatar: c!.avatar,
          },
          `contacts.${n}`,
        );
    });
    const chatsSrc = dev ? dev.chats : s.chats;
    chatsSrc.forEach((chat, n) => {
      unique(chat.id, `chats.${n}.id`);
      if (!registry.some((a) => a.id === chat.app && a.engine === "messaging"))
        fail(`chats.${n}.app`, "需要聊天 App");
      chat.participants.forEach((c, j) => {
        if (!contacts.has(c) && c !== "owner")
          fail(`chats.${n}.participants.${j}`, "联系人不存在: " + c);
      });
      chat.messages.forEach((m, j) => {
        if (
          m.senderId &&
          m.senderId !== "owner" &&
          !chat.participants.includes(m.senderId)
        )
          fail(`chats.${n}.messages.${j}.senderId`, "发信人不在会话中");
        const { senderId, ...item } = m;
        add(
          chat.app,
          {
            ...item,
            title: chat.title,
            sender:
              senderId === "owner"
                ? owner
                : contacts.get(senderId || "")?.name || m.sender || owner,
            avatar: m.avatar || contacts.get(senderId || "")?.avatar || "",
            outgoing: senderId === "owner" || m.outgoing,
            meta: {
              ...m.meta,
              conversationId: chat.id,
              participants: chat.participants.join(","),
            },
          },
          (dev ? `devices.${d.id}.` : "") + `chats.${n}.messages.${j}`,
        );
      });
    });
    devicePools[d.id] = data;
    if (dev)
      deviceWorks[d.id] = {
        phone: phoneCfg,
        apps: appsFor(devApps, devInstalled),
        data,
      };
  }
  function appsFor(
    devApps: (string | z.infer<typeof workSchema.shape.apps.element>)[],
    devInstalled: Set<string>,
  ): Work["apps"] {
    return [...registry]
      .sort((a, b) => {
        const ids = devApps.map((x) => (typeof x === "string" ? x : x.id));
        return (
          (ids.includes(a.id) ? ids.indexOf(a.id) : 999) -
          (ids.includes(b.id) ? ids.indexOf(b.id) : 999)
        );
      })
      .map((r) => {
        const custom = devApps.find(
          (a) => typeof a !== "string" && a.id === r.id,
        );
        return {
          id: r.id,
          name: r.name,
          installed: devInstalled.has(r.id),
          visible: devInstalled.has(r.id),
          dock: ["phone", "messages", "safari"].includes(r.id),
          folder: "",
          icon: "",
          ...(typeof custom === "object" ? custom : {}),
        };
      });
  }
  const rootInstalled = new Set(
    devices[0].dev
      ? devices[0].dev.installedApps
          .filter((a) => typeof a === "string" || a.installed)
          .map((a) => (typeof a === "string" ? a : a.id))
      : s.installedApps
          .filter((a) => typeof a === "string" || a.installed)
          .map((a) => (typeof a === "string" ? a : a.id)),
  );
  const installed = rootInstalled;
  const data = devicePools.player;
  const nodes = s.events.map((e, n) => {
    unique(e.id, `events.${n}.id`);
    return nodeSchema.parse({
      event: "",
      target: "",
      conditions: [],
      logic: "and",
      actions: [],
      next: [],
      once: true,
      x: 0,
      y: 0,
      ...e,
    });
  });
  const itemIds = new Set(
    Object.values(data)
      .flat()
      .map((i) => i.id),
  );
  // 双手机：unlock/hide/read 的目标也可能在李柱延手机的数据池里
  for (const pool of Object.values(devicePools))
    for (const i of Object.values(pool).flat()) itemIds.add(i.id);
  const allInstalled = new Set(installed);
  for (const d of devices) {
    const dev = d.dev;
    const devApps = dev ? dev.installedApps : s.installedApps;
    for (const a of devApps)
      if (typeof a === "string" || a.installed) allInstalled.add(typeof a === "string" ? a : a.id);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  nodes.forEach((n, i) => {
    n.next.forEach((x, j) => {
      if (!nodeIds.has(x)) fail(`events.${i}.next.${j}`, "不存在的节点: " + x);
    });
    if (n.event === "read" && n.target && !itemIds.has(n.target))
      fail(`events.${i}.target`, "不存在的内容");
    if (n.event === "openApp" && n.target && !allInstalled.has(n.target))
      fail(`events.${i}.target`, "事件 App 未安装");
    n.actions.forEach((a, j) => {
      if (["unlock", "hide"].includes(a.type) && !itemIds.has(a.key))
        fail(`events.${i}.actions.${j}.key`, "不存在的内容");
      if (a.type === "message" && !allInstalled.has(a.key))
        fail(`events.${i}.actions.${j}.key`, "消息 App 未安装");
      if (a.type === "choice" && !nodeIds.has(a.key))
        fail(`events.${i}.actions.${j}.key`, "选项节点不存在");
    });
    n.conditions.forEach((c, j) => {
      const [scope, ...rest] = c.key.split(":");
      const key = rest.join(":");
      if (["read", "unlocked"].includes(scope) && !itemIds.has(key))
        fail(`events.${i}.conditions.${j}.key`, "条件内容不存在");
      if (scope === "visited" && !allInstalled.has(key))
        fail(`events.${i}.conditions.${j}.key`, "条件 App 未安装");
    });
  });
  const errors = validateGraph(nodes);
  if (errors.length) fail("events", errors.join("; "));
  const rootPhoneCfg = {
    passcode: "",
    wallpaper: "sage",
    theme: "light",
    time: "21:41",
    battery: 86,
    network: "5G",
    notifications: true,
    ...(devices[0].dev ? devices[0].dev.phone : s.phone),
  };
  const work = validateWork({
    formatVersion: 1,
    id: s.id,
    title: s.title,
    description: s.description,
    category: "互动手机故事",
    cover: "",
    updatedAt: s.revision,
    phone: rootPhoneCfg,
    ...(s.devices ? { phones: deviceWorks } : {}),
    apps: appsFor(
      devices[0].dev ? devices[0].dev.installedApps : s.installedApps,
      installed,
    ),
    data,
    nodes,
    variables: s.variables,
    mode: nodes.length ? "mixed" : "explore",
  });
  return { story: s, work };
}
