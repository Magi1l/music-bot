import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { addXP } from './db';

// /addxp 명령어 등록 정보
// setDefaultMemberPermissions(PermissionFlagsBits.Administrator) 설정 시
// 관리자 권한이 없는 유저에게는 명령어가 아예 보이지 않습니다.
export const data = new SlashCommandBuilder()
  .setName('addxp')
  .setDescription('특정 유저의 XP를 추가합니다 (관리자 전용)')
  .addUserOption(option =>
    option.setName('대상').setDescription('XP를 추가할 유저').setRequired(true))
  .addIntegerOption(option =>
    option.setName('양').setDescription('추가할 XP 양').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

// /addxp 명령어 실행 코드
export async function execute(interaction) {
  const user = interaction.options.getUser('대상');
  const amount = interaction.options.getInteger('양');

  try {
    const updated = await addXP(user.id, amount);
    await interaction.reply({
      content: `${user.username}님의 XP가 ${amount}만큼 추가되었습니다. (현재: ${updated.points})`,
      ephemeral: true
    });
  } catch (error) {
    console.error('XP 추가 오류:', error);
    await interaction.reply({ content: 'XP 추가에 실패했습니다.', ephemeral: true });
  }
} 