library ieee;
use ieee.std_logic_1164.all;

-- PWM generator: pwm_out is high for DUTY of every PERIOD clock cycles.
entity pwm is
  generic (
    PERIOD : positive := 10;
    DUTY   : natural  := 3
  );
  port (
    clk, rst : in  std_logic;
    pwm_out  : out std_logic
  );
end entity pwm;

architecture rtl of pwm is
  signal cnt : natural range 0 to PERIOD - 1 := 0;
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' or cnt = PERIOD - 1 then
        cnt <= 0;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;

  pwm_out <= '1' when cnt < DUTY else '0';
end architecture rtl;
