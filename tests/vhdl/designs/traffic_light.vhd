library ieee;
use ieee.std_logic_1164.all;

-- Traffic-light controller: RED -> GREEN -> YELLOW -> RED.
-- State durations are in clock cycles; the lamp outputs have a driver delay.
entity traffic_light is
  generic (
    RED_CYCLES    : positive := 4;
    GREEN_CYCLES  : positive := 3;
    YELLOW_CYCLES : positive := 1;
    T_OUT         : time     := 2 ns
  );
  port (
    clk, rst            : in  std_logic;
    red, yellow, green  : out std_logic
  );
end entity traffic_light;

architecture fsm of traffic_light is
  type state_t is (S_RED, S_GREEN, S_YELLOW);
  signal state : state_t := S_RED;
  signal timer : natural range 0 to 255 := 0;
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        state <= S_RED;
        timer <= 0;
      else
        case state is
          when S_RED =>
            if timer = RED_CYCLES - 1 then
              state <= S_GREEN;
              timer <= 0;
            else
              timer <= timer + 1;
            end if;
          when S_GREEN =>
            if timer = GREEN_CYCLES - 1 then
              state <= S_YELLOW;
              timer <= 0;
            else
              timer <= timer + 1;
            end if;
          when S_YELLOW =>
            if timer = YELLOW_CYCLES - 1 then
              state <= S_RED;
              timer <= 0;
            else
              timer <= timer + 1;
            end if;
        end case;
      end if;
    end if;
  end process;

  red    <= '1' after T_OUT when state = S_RED    else '0' after T_OUT;
  yellow <= '1' after T_OUT when state = S_YELLOW else '0' after T_OUT;
  green  <= '1' after T_OUT when state = S_GREEN  else '0' after T_OUT;
end architecture fsm;
