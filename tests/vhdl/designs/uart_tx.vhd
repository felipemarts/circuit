library ieee;
use ieee.std_logic_1164.all;

-- 8N1 UART transmitter: idle high, start bit 0, 8 data bits LSB first, stop bit 1.
-- One bit lasts CLKS_PER_BIT clock cycles. Pulse `start` for one cycle to send `data`.
entity uart_tx is
  generic (CLKS_PER_BIT : positive := 4);
  port (
    clk, rst : in  std_logic;
    start    : in  std_logic;
    data     : in  std_logic_vector(7 downto 0);
    tx       : out std_logic := '1';
    busy     : out std_logic := '0'
  );
end entity uart_tx;

architecture rtl of uart_tx is
  type state_t is (IDLE, START_BIT, DATA_BITS, STOP_BIT);
  signal state   : state_t := IDLE;
  signal clk_cnt : natural range 0 to CLKS_PER_BIT - 1 := 0;
  signal bit_idx : natural range 0 to 7 := 0;
  signal shreg   : std_logic_vector(7 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        state <= IDLE;
        tx <= '1';
        busy <= '0';
        clk_cnt <= 0;
        bit_idx <= 0;
      else
        case state is
          when IDLE =>
            tx <= '1';
            busy <= '0';
            clk_cnt <= 0;
            bit_idx <= 0;
            if start = '1' then
              shreg <= data;
              busy <= '1';
              state <= START_BIT;
            end if;
          when START_BIT =>
            tx <= '0';
            if clk_cnt = CLKS_PER_BIT - 1 then
              clk_cnt <= 0;
              state <= DATA_BITS;
            else
              clk_cnt <= clk_cnt + 1;
            end if;
          when DATA_BITS =>
            tx <= shreg(bit_idx);
            if clk_cnt = CLKS_PER_BIT - 1 then
              clk_cnt <= 0;
              if bit_idx = 7 then
                bit_idx <= 0;
                state <= STOP_BIT;
              else
                bit_idx <= bit_idx + 1;
              end if;
            else
              clk_cnt <= clk_cnt + 1;
            end if;
          when STOP_BIT =>
            tx <= '1';
            if clk_cnt = CLKS_PER_BIT - 1 then
              clk_cnt <= 0;
              state <= IDLE;
            else
              clk_cnt <= clk_cnt + 1;
            end if;
        end case;
      end if;
    end if;
  end process;
end architecture rtl;
