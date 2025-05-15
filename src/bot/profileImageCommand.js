"use strict";
import axios from "axios";
import { AttachmentBuilder } from "discord.js";

// API 엔드포인트(나중에 실제 URL로 변경)
const PROFILE_IMAGE_API_URL = "https://yourdomain.com/api/generate-profile-image";

// 프로필 카드 이미지 가져오기 함수
async function fetchProfileCardImage(discordId, guildId) {
  const res = await axios.get(PROFILE_IMAGE_API_URL, {
    params: { discordId, guildId },
    responseType: "arraybuffer",
  });
  return Buffer.from(res.data, "binary");
}

// 명령어 핸들러 (discord.js v14 기준)
export default async function handleProfileImageCommand(interaction) {
  if (!interaction.isCommand() || interaction.commandName !== "profile") return;

  const discordId = interaction.user.id;
  const guildId = interaction.guildId;

  try {
    // 이미지 가져오기
    const imageBuffer = await fetchProfileCardImage(discordId, guildId);
    const attachment = new AttachmentBuilder(imageBuffer, { name: "profile.png" });
    await interaction.reply({ files: [attachment] });
  } catch (error) {
    console.error("프로필 이미지 생성 오류:", error);
    await interaction.reply({ content: "프로필 이미지를 불러오는 데 실패했습니다.", ephemeral: true });
  }
} 