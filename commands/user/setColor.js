const { SlashCommandBuilder } = require('discord.js');
const { broadcastRankingUpdate } = require('../../index');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('색상설정')
    .setDescription('닉네임 색상을 hex코드로 지정합니다. (예: FF0000)')
    .addStringOption(option =>
      option.setName('hex코드')
        .setDescription('#을 제외한 6자리 코드 (예: FF0000)')
        .setRequired(true)
    ),
  async execute(interaction) {
    const hex = interaction.options.getString('hex코드').replace(/^#/, '').toUpperCase();
    if (!/^([A-F0-9]{6})$/.test(hex)) {
      await interaction.reply({ content: '올바른 6자리 hex 코드(예: FF0000)만 입력하세요.', ephemeral: true });
      return;
    }
    const guild = interaction.guild;
    const member = interaction.member;
    const colorRoleName = `#${hex}`;
    // 1. 기존 색상 역할(이름이 #RRGGBB) 모두 제거
    const colorRolePattern = /^#[A-F0-9]{6}$/;
    const rolesToRemove = member.roles.cache.filter(role => colorRolePattern.test(role.name));
    if (rolesToRemove.size > 0) await member.roles.remove(rolesToRemove);
    // 2. 해당 색상 역할이 이미 있으면 재사용, 없으면 새로 생성
    let colorRole = guild.roles.cache.find(r => r.name === colorRoleName);
    if (!colorRole) {
      colorRole = await guild.roles.create({
        name: colorRoleName,
        color: `#${hex}`,
        reason: `${member.user.tag}의 색상설정 명령어 요청`
      });
    }
    // 3. 새 색상 역할 부여
    await member.roles.add(colorRole);
    await interaction.reply({ content: `닉네임 색상이 #${hex}로 변경되었습니다!`, ephemeral: true });
    await broadcastRankingUpdate();
  }
}; 