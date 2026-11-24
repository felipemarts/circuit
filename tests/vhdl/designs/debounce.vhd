library ieee;
use ieee.std_logic_1164.all;

-- Button debouncer: a two-flop synchronizer, then `clean` follows the input
-- only after it has been stable (and different) for STABLE_CYCLES clock edges.
entity debounce is
  generic (STABLE_CYCLES : positive := 4);
  port (
    clk   : in  std_logic;
    noisy : in  std_logic;
    clean : out std_logic
  );
end entity debounce;

architecture rtl of debounce is
  signal sync0, sync1 : std_logic := '0';
  signal cnt          : natural range 0 to STABLE_CYCLES := 0;
  signal state        : std_logic := '0';
begin
  process (clk)
  begin
    if rising_edge(clk) then
      sync0 <= noisy;
      sync1 <= sync0;
      if sync1 = state then
        cnt <= 0;
      elsif cnt = STABLE_CYCLES - 1 then
        state <= sync1;
        cnt <= 0;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;

  clean <= state;
end architecture rtl;
